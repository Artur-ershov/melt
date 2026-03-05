var LOG_SHEET_NAME = "Выигрыши";
var CONFIG_SHEET_NAME = "Призы";
var SETTINGS_SHEET_NAME = "Настройки таблицы";

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "info",
    message: "Используйте POST для запроса приза."
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // ==========================================
  // 1. БАЗОВЫЕ ПРОВЕРКИ (БЕЗ ОЧЕРЕДИ)
  // ==========================================
  if (!e || !e.postData || !e.postData.contents) {
    return jsonError("Пустой запрос");
  }

  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return jsonError("Не удалось распарсить тело запроса как JSON");
  }

  var email = (data.email || "").toString().toLowerCase().trim();
  if (!email || email.indexOf("@") === -1) {
    return jsonError("Некорректный email");
  }

  var userLocationGroup = normalizeUserLocation(extractLocationFromData(data));
  var userLocationLower = userLocationGroup.toLowerCase();

  // ==========================================
  // 2. ВСТАЕМ В ОЧЕРЕДЬ К БАЗЕ ДАННЫХ
  // ==========================================
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonError("Слишком много желающих! 😅 Сервер немного перегружен, попробуйте нажать кнопку еще раз через пару секунд.");
  }

  // ==========================================
  // 3. ОСНОВНАЯ ЛОГИКА (ПОД ЗАМКОМ)
  // ==========================================
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var logSheet = ss.getSheetByName(LOG_SHEET_NAME);
    var configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);
    var settingsSheet = ss.getSheetByName(SETTINGS_SHEET_NAME);

    if (!logSheet) return jsonError('Не найден лист лога "' + LOG_SHEET_NAME + '"');
    if (!configSheet) return jsonError('Не найден лист конфигурации призов "' + CONFIG_SHEET_NAME + '"');

    var logValues = logSheet.getDataRange().getValues();
    var usedCounts = {};
    var totalDraws = Math.max(logValues.length - 1, 0); // текущий ход

    // Проверка на дубликаты
    for (var i = 1; i < logValues.length; i++) {
      var row = logValues[i];
      var rowEmail = (row[0] || "").toString().toLowerCase().trim();
      if (rowEmail === email) {
        return jsonResponse({
          status: "error",
          message: "Вы уже получили свой приз: " + (row[2] || row[1] || "")
        });
      }
      var loggedPrizeId = row[1];
      if (loggedPrizeId) {
        usedCounts[loggedPrizeId] = (usedCounts[loggedPrizeId] || 0) + 1;
      }
    }

    // Читаем лимиты ходов
    var redPrizeLimit = null;
    var yellowPrizeLimit = null;

    if (settingsSheet) {
      var settingsValues = settingsSheet.getDataRange().getValues();
      for (var s = 0; s < settingsValues.length; s++) {
        var settingsRow = settingsValues[s];
        var keyCell = (settingsRow[0] || "").toString().trim().toLowerCase();
        var valueCell = Number(settingsRow[1]);

        if (!keyCell || isNaN(valueCell) || valueCell <= 0) continue;

        if (keyCell.indexOf("красные") !== -1) {
          redPrizeLimit = valueCell;
        } else if (keyCell.indexOf("желтые") !== -1) {
          yellowPrizeLimit = valueCell;
        }
      }
    }

    var configValues = configSheet.getDataRange().getValues();
    if (configValues.length <= 1) {
      return jsonError("В конфигурации призов нет данных");
    }

    // Заголовки
    var header = configValues[0].map(function (h) {
      return (h || "").toString().trim().toLowerCase();
    });

    function col(name) {
      var idx = header.indexOf(name.toLowerCase());
      return idx === -1 ? null : idx;
    }

    var colPrizeId = col("prizeid");
    var colTitle = col("title");
    var colSubtitle = col("subtitle");
    var colRarity = col("rarity");
    var colDescription = col("description");
    var colMaxCount = col("maxcount");
    var colBobry = col("bobry");
    var colActive = col("active");
    var colQueue = col("queue");
    var colLocationPrize = col("локация");
    if (colLocationPrize === null) {
      colLocationPrize = col("location");
    }

    if (colPrizeId === null || colTitle === null || colMaxCount === null) {
      return jsonError('Не найдены обязательные колонки в листе "Призы"');
    }

    var redPrizes = [];
    var yellowPrizes = [];
    var standardPrizes = [];

    // Раскладываем призы
    for (var r = 1; r < configValues.length; r++) {
      var cfgRow = configValues[r];
      var prizeId = cfgRow[colPrizeId];
      if (!prizeId) continue;

      var activeCell = colActive !== null ? cfgRow[colActive] : null;
      var isActive = true;
      if (activeCell === false || (typeof activeCell === "string" && activeCell.toLowerCase() === "false")) {
        isActive = false;
      }
      if (!isActive) continue;

      if (colLocationPrize !== null) {
        var prizeLocationCell = cfgRow[colLocationPrize] || "";
        var prizeLocationText = prizeLocationCell.toString().toLowerCase();
        if (prizeLocationText && prizeLocationText.indexOf(userLocationLower) === -1) continue;
      }

      var maxCountRaw = colMaxCount !== null ? cfgRow[colMaxCount] : null;
      var maxCount = Number(maxCountRaw);
      var alreadyUsed = usedCounts[prizeId] || 0;
      var remaining;

      if (!isNaN(maxCount) && maxCount > 0) {
        remaining = maxCount - alreadyUsed;
        if (remaining <= 0) continue;
      } else {
        continue;
      }

      var queueValue = colQueue !== null ? (cfgRow[colQueue] || "") : "";
      var queueNormalized = queueValue.toString().toLowerCase();

      var prizeObj = {
        id: prizeId,
        title: colTitle !== null ? (cfgRow[colTitle] || "") : "",
        subtitle: colSubtitle !== null ? (cfgRow[colSubtitle] || "") : "",
        rarity: colRarity !== null ? (cfgRow[colRarity] || "") : "",
        description: colDescription !== null ? (cfgRow[colDescription] || "") : "",
        bobry: colBobry !== null ? Number(cfgRow[colBobry] || 0) || 0 : 0,
        weight: remaining
      };

      if (isRedQueue(queueNormalized) && redPrizeLimit !== null) {
        redPrizes.push(prizeObj);
      } else if (isYellowQueue(queueNormalized) && yellowPrizeLimit !== null) {
        yellowPrizes.push(prizeObj);
      } else {
        standardPrizes.push(prizeObj);
      }
    }

    if (redPrizes.length === 0 && yellowPrizes.length === 0 && standardPrizes.length === 0) {
      return jsonError("Все призы уже разыграны или отключены");
    }

    function pickFromBucket(bucket) {
      var totalW = 0;
      for (var j = 0; j < bucket.length; j++) totalW += bucket[j].weight;
      var rnd = Math.random() * totalW;
      for (var k = 0; k < bucket.length; k++) {
        rnd -= bucket[k].weight;
        if (rnd <= 0) return bucket[k];
      }
      return bucket[bucket.length - 1];
    }

    var chosenPrize = null;

    // Выдаем Красный
    if (redPrizes.length > 0 && redPrizeLimit !== null) {
      var pRed = 0;
      if (totalDraws < redPrizeLimit) {
        var redSlotsLeft = redPrizeLimit - totalDraws;
        var redTotalRemaining = 0;
        for (var ri = 0; ri < redPrizes.length; ri++) redTotalRemaining += redPrizes[ri].weight;
        pRed = redSlotsLeft > 0 ? (redTotalRemaining / redSlotsLeft) : 1;
      } else {
        pRed = 1;
      }
      if (pRed >= 1 || Math.random() < pRed) chosenPrize = pickFromBucket(redPrizes);
    }

    // Выдаем Желтый
    if (!chosenPrize && yellowPrizes.length > 0 && yellowPrizeLimit !== null) {
      var pYellow = 0;
      if (totalDraws < yellowPrizeLimit) {
        var yellowSlotsLeft = yellowPrizeLimit - totalDraws;
        var yellowTotalRemaining = 0;
        for (var yi = 0; yi < yellowPrizes.length; yi++) yellowTotalRemaining += yellowPrizes[yi].weight;
        pYellow = yellowSlotsLeft > 0 ? (yellowTotalRemaining / yellowSlotsLeft) : 1;
      } else {
        pYellow = 1;
      }
      if (pYellow >= 1 || Math.random() < pYellow) chosenPrize = pickFromBucket(yellowPrizes);
    }

    // Выдаем Стандартный
    if (!chosenPrize) {
      if (standardPrizes.length > 0) chosenPrize = pickFromBucket(standardPrizes);
      else if (yellowPrizes.length > 0) chosenPrize = pickFromBucket(yellowPrizes);
      else if (redPrizes.length > 0) chosenPrize = pickFromBucket(redPrizes);
    }

    if (!chosenPrize) return jsonError("Не удалось выбрать приз");

    // Записываем результат
    logSheet.appendRow([
      email,
      chosenPrize.id,
      chosenPrize.title,
      chosenPrize.rarity,
      userLocationGroup,
      new Date()
    ]);

    return jsonResponse({
      status: "success",
      prize: {
        id: chosenPrize.id,
        title: chosenPrize.title,
        subtitle: chosenPrize.subtitle || "",
        rarity: chosenPrize.rarity,
        description: chosenPrize.description,
        bobry: chosenPrize.bobry
      }
    });

  } catch (err) {
    return jsonError("Внутренняя ошибка: " + err);
  } finally {
    // 4. ГАРАНТИРОВАННО СНИМАЕМ ЛОК
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return jsonResponse({ status: "error", message: message });
}

function normalizeUserLocation(raw) {
  var value = (raw || "").toString().toLowerCase().trim();
  if (!value) return "удаленный сотрудник";
  if (value.indexOf("моск") !== -1 || value.indexOf("moscow") !== -1 || value.indexOf("msk") !== -1) return "сотрудник московского офиса";
  if (value.indexOf("регион") !== -1) return "сотрудник регионального офиса";
  if (value.indexOf("удален") !== -1 || value.indexOf("remote") !== -1 || value.indexOf("home") !== -1) return "удаленный сотрудник";
  return "удаленный сотрудник";
}

function extractLocationFromData(data) {
  if (!data || typeof data !== "object") return null;
  for (var key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    var lowerKey = key.toString().toLowerCase();
    if (lowerKey === "location" || lowerKey === "локация") return data[key];
  }
  return null;
}

function isRedQueue(queue) {
  var q = (queue || "").toString().toLowerCase().trim();
  return q === "приоритет" || q === "priority";
}

function isYellowQueue(queue) {
  var q = (queue || "").toString().toLowerCase().trim();
  return q === "быстрый" || q === "fast";
}
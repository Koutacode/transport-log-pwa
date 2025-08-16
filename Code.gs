/**
 * Google Apps Script backend for the transport log PWA.
 *
 * This script should be bound to a Google Spreadsheet. It exposes a
 * doPost() function that receives log data via HTTP POST and
 * appends it to the first sheet. An onOpen() function is included
 * to create the header row the first time the sheet is opened.
 */

/**
 * Ensure the spreadsheet has a header row. Called when the sheet is
 * opened from the browser. If the sheet has no data, append a
 * header row corresponding to the expected schema.
 */
function onOpen() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      '日付',
      '出発地名',
      '到着地名',
      '出発時刻',
      '到着時刻',
      '運転時間(分)',
      '休憩合計(分)',
      '走行距離(km)',
      '給油量(L)',
      '給油費用(円)',
      '出発緯度',
      '出発経度',
      '到着緯度',
      '到着経度',
      'メモ/休息詳細'
    ]);
  }
}

/**
 * Handle GET requests. Primarily used to verify the script is
 * reachable. Returns a plain text OK message.
 */
function doGet(e) {
  return ContentService.createTextOutput('OK');
}

/**
 * Handle POST requests. Expects a JSON body containing the log
 * record fields. Appends a new row to the first sheet and returns
 * a JSON response with the row number.
 */
function doPost(e) {
  var jsonString = e.postData.contents;
  var data = {};
  try {
    data = JSON.parse(jsonString);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var row = [
    data.date || '',
    data.departureName || '',
    data.arrivalName || '',
    data.departureTime || '',
    data.arrivalTime || '',
    data.drivingMinutes || 0,
    data.breakMinutes || 0,
    data.distanceKm || 0,
    data.fuelLitres || 0,
    data.fuelCost || 0,
    data.departureLat || 0,
    data.departureLng || 0,
    data.arrivalLat || 0,
    data.arrivalLng || 0,
    data.note || ''
  ];
  sheet.appendRow(row);
  var rowNumber = sheet.getLastRow();
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, rowNumber: rowNumber }))
    .setMimeType(ContentService.MimeType.JSON);
}
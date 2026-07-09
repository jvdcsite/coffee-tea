/**
 * Google Apps Script — Sheets sync backend for the coffee & tea site.
 *
 * Setup:
 *   1. Create a new Google Sheet. Name a tab "Products" (exact name matters).
 *   2. Extensions → Apps Script, paste this whole file in as Code.gs.
 *   3. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone with the link
 *        (Access control happens on the Worker side via the secret URL and
 *        the admin auth gate in front of it — this endpoint has no auth of
 *        its own, so do not share the URL beyond the Worker secret.)
 *   4. Copy the deployed Web App URL and set it as a Worker secret:
 *        wrangler secret put SHEETS_WEBHOOK_URL
 *   5. Whenever you edit worker/index.js or this file, redeploy this Apps
 *      Script as a NEW VERSION (Deploy → Manage deployments → edit → new
 *      version) — Apps Script does not auto-update a live Web App URL from
 *      a code change alone.
 *
 * Sheet columns (row 1 header, must match exactly):
 *   id | category | name | origin | process | roast_level | leaf_type |
 *   caffeine_level | altitude_m | flavor_notes | description | price_cents |
 *   currency | stock_count | weight_grams | image_key | thumb_key | active
 */

const SHEET_NAME = "Products";
const COLUMNS = [
  "id", "category", "name", "origin", "process", "roast_level", "leaf_type",
  "caffeine_level", "altitude_m", "flavor_notes", "description", "price_cents",
  "currency", "stock_count", "weight_grams", "image_key", "thumb_key", "active",
];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
  }
  return sheet;
}

function doGet(e) {
  const action = e.parameter.action;
  if (action === "list") {
    return jsonResponse_({ products: readAllRows_() });
  }
  return jsonResponse_({ error: "Unknown action" }, 400);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "push") {
    writeAllRows_(body.products || []);
    return jsonResponse_({ ok: true, count: (body.products || []).length });
  }

  return jsonResponse_({ error: "Unknown action" }, 400);
}

/** Full overwrite — this sheet is a mirror/backup, not co-authored live. */
function writeAllRows_(products) {
  const sheet = getSheet_();
  sheet.clearContents();
  sheet.appendRow(COLUMNS);
  if (products.length === 0) return;

  const rows = products.map((p) => COLUMNS.map((col) => (p[col] === undefined || p[col] === null ? "" : p[col])));
  sheet.getRange(2, 1, rows.length, COLUMNS.length).setValues(rows);
}

function readAllRows_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  return values
    .filter((row) => row[0] !== "") // skip blank rows
    .map((row) => {
      const obj = {};
      COLUMNS.forEach((col, i) => { obj[col] = row[i] === "" ? null : row[i]; });
      // Sheets stores numbers as numbers already; coerce the ones that must
      // be numeric in D1 in case a human typed something odd while editing.
      ["price_cents", "stock_count", "weight_grams", "altitude_m", "active"].forEach((numCol) => {
        if (obj[numCol] !== null && obj[numCol] !== "") obj[numCol] = Number(obj[numCol]);
      });
      return obj;
    });
}

function jsonResponse_(data, status) {
  // Apps Script Web Apps can't set a custom HTTP status on ContentService
  // output directly — callers should check the response body's shape
  // rather than the status code for this endpoint. The Worker's fetch
  // calls here rely on response.ok being true for any 200, which Apps
  // Script always returns; check body.error to detect a logical failure.
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

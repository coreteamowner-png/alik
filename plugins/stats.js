const { Module } = require("../main");
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const jimp = require('jimp'); // Image bananay kay liye

// ---------------- CONFIG ----------------
// â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼
// Aap ki fresh cookie (jco3d... wali)
const PHPSESSID_OVERRIDE = "qlbfmsl4clreclloj6jk8bdnbj";
// â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²

const BASE = "http://mysmsportal.com";
const TODAY_PATH = "/index.php?opt=shw_sts_today";
const TEMP_IMAGE_PATH = path.join(__dirname, 'stats_temp.png'); // Temp image yahan save hogi

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": BASE + "/index.php?login=1",
    "Cookie": `PHPSESSID=${PHPSESSID_OVERRIDE}` 
};

// ---------------- Helpers (Data nikalnay walay) ----------------
// (Yeh functions bilkul fixed hain)

async function fetch_today(sess) {
    const r = await sess.get(BASE + TODAY_PATH, { headers: HEADERS });
    return r.data;
}

function safe_int_from_text(txt) {
    if (txt === null || txt === undefined) return 0;
    let s = String(txt).trim().replace(/,/g, "").replace(/\xa0/g, " ");
    const m = s.match(/-?\d+/); 
    if (!m) return 0; 
    try {
        return parseInt(m[0], 10); // Fixed: m[0]
    } catch (e) {
        return 0;
    }
}

function norm_status(s) {
    if (!s) return null;
    let t = s.replace(/\xa0/g, " ");
    t = t.replace(/[\u2010-\u2015\u2212\u2012\u2013]+/g, "-"); 
    t = t.replace(/[^\w\s\-]/g, " "); 
    t = t.replace(/[-_]+/g, " ");
    t = t.replace(/\s+/g, " ").trim().toUpperCase();

    if (t.includes("NOT") && t.includes("PAID")) return "NOT TO BE PAID";
    if (t.includes("TO") && t.includes("BE") && t.includes("PAID")) return "TO BE PAID";
    return null;
}

function find_table_and_headers($) {
    let best_tbl = null;
    let best_hdrs = [];

    $('table').each((i, tbl) => {
        let headers = [];
        const thead = $(tbl).find('thead');
        if (thead.length > 0) {
            headers = thead.find('th, td').map((j, th) => $(th).text().trim().toUpperCase()).get();
        } else {
            const first = $(tbl).find('tr').first();
            if (first.length > 0) {
                headers = first.find('th, td').map((j, td) => $(td).text().trim().toUpperCase()).get();
            }
        }
        const joined = headers.join(' ');
        if (joined.includes("CLIENT") && joined.includes("STATUS") && (joined.includes("MESSAGES") || joined.includes("NUMBER"))) {
            best_tbl = tbl;
            best_hdrs = headers;
            return false; 
        }
    });

    if (best_tbl) return { tbl: best_tbl, headers: best_hdrs };

    $('table').each((i, tbl) => {
        const txt = $(tbl).text().trim().toUpperCase();
        if (txt.includes("CLIENT") && txt.includes("STATUS")) {
            let headers = [];
            const thead = $(tbl).find('thead');
            if (thead.length > 0) {
                headers = thead.find('th, td').map((j, th) => $(th).text().trim().toUpperCase()).get();
            } else {
                const first = $(tbl).find('tr').first();
                headers = first.find('th, td').map((j, td) => $(td).text().trim().toUpperCase()).get();
            }
            best_tbl = tbl;
            best_hdrs = headers;
            return false; 
        }
    });
    
    return { tbl: best_tbl, headers: best_hdrs };
}

function get_col_indices_from_headers(headers) {
    let col_msg = null, col_client = null, col_status = null;
    headers.forEach((h, i) => {
        const hh = (h || "").toUpperCase();
        if (hh.includes("MESSAGE") && col_msg === null) col_msg = i;
        if (hh.includes("CLIENT") && col_client === null) col_client = i;
        if (hh.includes("STATUS") && col_status === null) col_status = i;
    });
    return { col_msg, col_client, col_status };
}

function compute_counts_from_table(tbl, headers, $) {
    const { col_msg, col_client, col_status } = get_col_indices_from_headers(headers);
    const counts = {};

    $(tbl).find('tr').each((i, tr) => {
        const cells = $(tr).find('td, th');
        if (cells.length < 2) return;

        const header_like = cells.slice(0, Math.min(6, cells.length)).map((j, c) => $(c).text().trim().toUpperCase()).get().join(' ');
        if (header_like.includes("CLIENT") && header_like.includes("STATUS")) return; 

        let client = "";
        if (col_client !== null && col_client < cells.length) {
            client = $(cells[col_client]).text().trim();
        } else {
            cells.each((j, c) => {
                const t = $(c).text().trim();
                if (t && /[A-Za-z]/.test(t) && !/^\+?\d+$/.test(t)) {
                    client = t;
                    return false; 
                }
            });
        }
        if (!client) return;
        client = client.trim();

        let msg_val = 0;
        if (col_msg !== null && col_msg < cells.length) {
            msg_val = safe_int_from_text($(cells[col_msg]).text());
        } else {
            cells.each((j, c) => {
                const n = safe_int_from_text($(c).text());
                if (n >= 0 && n < 1000000) {
                    msg_val = n;
                    return false; 
                }
            });
        }

        let status_raw = "";
        if (col_status !== null && col_status < cells.length) {
            status_raw = $(cells[col_status]).text().trim();
        } else {
            cells.each((j, c) => {
                const t = $(c).text().toUpperCase();
                if (t.includes("PAID") || t.includes("NOT")) {
                    status_raw = $(c).text();
                    return false; 
                }
            });
            if (!status_raw && cells.length > 0) {
                status_raw = $(cells[cells.length - 1]).text().trim();
            }
        }

        const status_key = norm_status(status_raw);
        if (status_key !== "TO BE PAID" && status_key !== "NOT TO BE PAID") {
            return; 
        }

        if (!counts[client]) {
            counts[client] = { "TO BE PAID": 0, "NOT TO BE PAID": 0 };
        }
        counts[client][status_key] += msg_val;
    });

    return counts;
}

// â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼
//                           NEW IMAGE FUNCTION
// â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼
async function generate_stats_image(counts) {
    const sortedClients = Object.keys(counts).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    
    // Calculate image dimensions
    const lineHeight = 30;
    const padding = 20;
    const headerHeight = 70;
    const footerHeight = 70;
    const imgWidth = 500;
    const imgHeight = headerHeight + footerHeight + (sortedClients.length * lineHeight) + padding;

    // Create a new image
    const image = await new jimp(imgWidth, imgHeight, '#FFFFFF'); // White background
    
    // Load fonts (Jimp default fonts)
    const font = await jimp.loadFont(jimp.FONT_SANS_32_BLACK); // For title
    const fontRegular = await jimp.loadFont(jimp.FONT_SANS_16_BLACK); // For data
    
    // Colors
    const colorBlack = 0x000000FF;
    const colorGray = 0x808080FF;

    // --- Print Title ---
    image.print(font, padding, padding, "Live Today Stats", imgWidth - (padding*2));

    // --- Print Headers (CLIENT & Paid) ---
    const clientX = padding;
    const paidX = 350;
    const headerY = headerHeight - 10;
    
    image.print(fontRegular, clientX, headerY, "CLIENT", colorGray);
    image.print(fontRegular, paidX, headerY, "Paid", colorGray); // Renamed to "Paid"
    
    // --- Print Data ---
    let currentY = headerY + lineHeight;
    let total_tbp = 0;

    for (const c of sortedClients) {
        const tbp = counts[c]["TO BE PAID"] || 0;
        total_tbp += tbp;
        
        // Yeh line wize print karay ga
        image.print(fontRegular, clientX, currentY, c); // Client name
        image.print(fontRegular, paidX, currentY, tbp.toLocaleString()); // Paid amount
        
        currentY += lineHeight;
    }
    
    // --- Print Footer (Grand Total) ---
    currentY += 10; // Add some space
    image.print(font, clientX, currentY, "GRAND TOTAL:");
    image.print(font, paidX - 50, currentY, total_tbp.toLocaleString());

    // --- Save and return path ---
    await image.writeAsync(TEMP_IMAGE_PATH);
    return TEMP_IMAGE_PATH;
}
// â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²
//                           NEW IMAGE FUNCTION
// â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²


// ---------------- COMMAND REGISTRATION (Raganork-MD format) ----------------

Module(
  {
    pattern: "stats ?(.*)",
    fromMe: false, 
    desc: "Fetches today's stats from mysmsportal.",
  },
  async (message, match) => {
    
    if (!PHPSESSID_OVERRIDE) {
        return await message.sendReply("Error: `PHPSESSID_OVERRIDE` is not set in `stats.js` file.");
    }

    try {
        await message.sendReply("Analysing portal stats... âŒ›");

        const sess = axios.create(); 
        const html = await fetch_today(sess);
        const $ = cheerio.load(html);
        
        let { tbl, headers } = find_table_and_headers($);
        
        if (!tbl) {
            const tlist = $('table');
            if (tlist.length > 0) { tbl = tlist[0]; headers = []; }
        }

        if (!tbl) {
            return await message.sendReply("Error: No table found on page. Your `PHPSESSID` might be expired or invalid. Please get a new one.");
        }
        
        const counts = compute_counts_from_table(tbl, headers, $);
        
        if (Object.keys(counts).length === 0) {
            return await message.sendReply("```No data parsed from page. (Clients found, but counts are zero or invalid).```");
        }

        // â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼
        //                           SENDING IMAGE
        // â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼â–¼
        
        // 1. Image banayein
        const imagePath = await generate_stats_image(counts);

        // 2. Image ko send karein
        await message.client.sendMessage(
            message.jid,
            { 
                image: { url: imagePath }, // Local file path
                caption: "ðŸ“Š Here are the live stats:"
            }
        );

        // 3. Temp image ko delete karein
        fs.unlinkSync(imagePath);
        
        // â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²
        //                           SENDING IMAGE
        // â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²â–²
        
    } catch (e) {
        console.error("Stats Command Error:", e);
        if (e.message && (e.message.includes('404') || e.message.includes('302') || e.message.includes('timeout'))) {
             await message.sendReply(`Error: Request failed. Your \`PHPSESSID\` is likely expired. Please get a new one.\n\n(Debug: ${e.message})`);
        } else {
             await message.sendReply(`An error occurred: ${e.message}`);
        }
    }
  }
);

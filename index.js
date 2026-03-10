import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from "@whiskeysockets/baileys";

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

/* =======================
   CREATE REQUIRED FOLDERS
======================= */

const folders = ["session", "uploads", "public"];

folders.forEach((f) => {
  if (!fs.existsSync(f)) {
    fs.mkdirSync(f);
  }
});

/* =======================
   VARIABLES
======================= */

const sockets = {};
const stopFlags = {};

/* =======================
   UTILS
======================= */

function generateKey() {
  return crypto.randomBytes(10).toString("hex");
}

/* =======================
   WHATSAPP CONNECT
======================= */

async function connectWhatsApp(phone, key, sendPairing) {
  const sessionPath = "./session/" + key;

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Chrome"),
    auth: state,
    printQRInTerminal: false
  });

  sockets[key] = sock;

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(phone);
      sendPairing(code);
    }, 2000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("WhatsApp Connected");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;

      if (reason !== DisconnectReason.loggedOut) {
        connectWhatsApp(phone, key, sendPairing);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

/* =======================
   ROUTES
======================= */

app.get("/health", (req, res) => {
  res.send("Server OK");
});

app.get("/", (req, res) => {
  const file = path.join(process.cwd(), "public/index.html");

  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.send("Server running");
  }
});

/* LOGIN */

app.post("/login", async (req, res) => {
  try {
    let { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.json({
        success: false,
        message: "Phone required"
      });
    }

    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

    const key = generateKey();

    const sendPairing = (code) => {
      res.json({
        success: true,
        pairingCode: code,
        uniqueKey: key
      });
    };

    await connectWhatsApp(phoneNumber, key, sendPairing);
  } catch (err) {
    res.json({
      success: false,
      message: err.message
    });
  }
});

/* GET GROUPS */

app.post("/getGroupUID", async (req, res) => {
  try {
    const { uniqueKey } = req.body;

    const sock = sockets[uniqueKey];

    if (!sock) {
      return res.json({
        success: false,
        message: "Not connected"
      });
    }

    const groups = await sock.groupFetchAllParticipating();

    const list = Object.values(groups).map((g) => ({
      name: g.subject,
      id: g.id
    }));

    res.json({
      success: true,
      groups: list
    });
  } catch (e) {
    res.json({
      success: false,
      message: e.message
    });
  }
});

/* START MESSAGE */

app.post("/startMessaging", upload.single("file"), async (req, res) => {
  try {
    const { uniqueKey, target, speed } = req.body;

    const sock = sockets[uniqueKey];

    if (!sock) {
      return res.json({
        success: false,
        message: "Not connected"
      });
    }

    const file = req.file.path;

    const text = fs.readFileSync(file, "utf8");

    const messages = text.split("\n").filter((m) => m.trim());

    let i = 0;

    stopFlags[uniqueKey] = setInterval(async () => {
      const msg = messages[i];

      await sock.sendMessage(target, { text: msg });

      i++;

      if (i >= messages.length) {
        i = 0;
      }
    }, speed * 1000);

    res.json({
      success: true
    });
  } catch (e) {
    res.json({
      success: false,
      message: e.message
    });
  }
});

/* STOP */

app.post("/stop", (req, res) => {
  const { uniqueKey } = req.body;

  if (stopFlags[uniqueKey]) {
    clearInterval(stopFlags[uniqueKey]);
  }

  res.json({
    success: true
  });
});

/* =======================
   SERVER START
======================= */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN;
if (!ADMIN_PIN) {
  console.error("ERROR: Environment variable ADMIN_PIN wajib diatur.");
  process.exit(1);
}

const files = {
  "/": "target.html",
  "/target.html": "target.html",
  "/remote.html": "remote.html"
};

const server = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/upload-video" && req.method === "POST") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) {
      res.writeHead(401, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:false,error:"PIN admin salah"}));
    }

    if (!/^video\/mp4(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      res.writeHead(415, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:false,error:"Kirim file MP4"}));
    }

    const maxBytes = 100 * 1024 * 1024;
    const dir = path.join(__dirname, "videos");
    fs.mkdirSync(dir, {recursive:true});
    const temp = path.join(dir, "shared-video-" + Date.now() + ".tmp");
    const dest = path.join(dir, "shared-video.mp4");
    const out = fs.createWriteStream(temp, {flags:"wx"});
    let total = 0, failed = false;

    function rejectUpload(status, message) {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(temp, () => {});
      if (!res.headersSent) {
        res.writeHead(status, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false,error:message}));
      }
    }

    req.on("data", chunk => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejectUpload(413, "Ukuran maksimum 100 MB");
        req.resume();
      }
    });

    req.on("aborted", () => rejectUpload(400, "Unggahan terputus"));
    out.on("error", () => rejectUpload(500, "Gagal menyimpan video"));

    out.on("finish", () => {
      if (failed) return;
      if (total === 0) return rejectUpload(400, "File kosong");

      fs.rename(temp, dest, err => {
        if (err) {
          fs.unlink(temp, () => {});
          if (!res.headersSent) {
            res.writeHead(500, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ok:false,error:"Gagal menyimpan video"}));
          }
          return;
        }
        if (!res.headersSent) {
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,message:"Video berhasil diunggah"}));
        }
      });
    });

    req.pipe(out);
    return;
  }


  // Sajikan hanya empat video yang telah ditentukan.
  const videoMatch = url.pathname.match(/^\/videos\/(video[1-4]\.mp4|shared-video\.mp4)$/);
  if (videoMatch) {
    const videoPath = path.join(__dirname, "videos", videoMatch[1]);
    return fs.stat(videoPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Video tidak ditemukan");
      }

      const range = req.headers.range;
      if (range) {
        const parts = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!parts) {
          res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
          return res.end();
        }

        let start = parts[1] ? Number(parts[1]) : 0;
        let end = parts[2] ? Number(parts[2]) : stat.size - 1;
        if (start >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
          return res.end();
        }
        end = Math.min(end, stat.size - 1);

        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Range": "bytes " + start + "-" + end + "/" + stat.size,
          "Cache-Control": "no-store"
        });
        return fs.createReadStream(videoPath, { start, end }).pipe(res);
      }

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": stat.size,
        "Cache-Control": "no-store"
      });
      fs.createReadStream(videoPath).pipe(res);
    });
  }

  const file = files[url.pathname];

  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404 - Halaman tidak ditemukan");
  }

  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end("Gagal membaca halaman");
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });

    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

let screenLockPin = "";

const allowedEffects = new Set([
  "jump", "virus", "glitch", "bsod", "custom", "clear",
  "video1", "video2", "video3", "video4", "stopvideo", "playuploaded"
]);

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function countTargets() {
  return [...wss.clients].filter(
    s => s.role === "target" &&
         s.readyState === WebSocket.OPEN
  ).length;
}

function updateAdmins() {
  const count = countTargets();

  for (const socket of wss.clients) {
    if (socket.role === "admin" && socket.authed) {
      send(socket, { type: "targets", count });
    }
  }
}

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const role = url.searchParams.get("role");

  if (!["target", "admin"].includes(role)) {
    socket.close(1008, "Invalid role");
    return;
  }

  socket.role = role;
  socket.authed = role === "target";
  socket.failedPins = 0;

  console.log("Browser terhubung:", role);

  if (role === "admin") {
    send(socket, { type: "hello" });
  }

  updateAdmins();

  socket.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (socket.role === "target") {
      if (data.type === "unlock-attempt") {
        const ok = !!screenLockPin &&
          String(data.pin || "") === screenLockPin;
        send(socket, {type:"unlock-result", ok});
        if (ok) send(socket, {type:"screen-unlock"});
        return;
      }

      if (data.type !== "quiz-progress") return;

      const current = Number(data.current);
      const total = Number(data.total);
      const answered = Number(data.answered);

      if (!Number.isInteger(current) || !Number.isInteger(total) ||
          !Number.isInteger(answered) || total < 1 ||
          current < 1 || current > total ||
          answered < 0 || answered > total) return;

      const progress = {
        type: "quiz-progress",
        stage: ["mengerjakan", "menjawab", "selesai"].includes(data.stage)
          ? data.stage : "mengerjakan",
        current, total, answered
      };

      for (const admin of wss.clients) {
        if (admin.role === "admin" && admin.authed &&
            admin.readyState === WebSocket.OPEN) {
          send(admin, progress);
        }
      }
      return;
    }

    if (socket.role !== "admin") return;

    if (!socket.authed) {
      if (data.type !== "auth") return;

      if (String(data.pin) === ADMIN_PIN) {
        socket.authed = true;
        send(socket, { type: "auth", ok: true });
        updateAdmins();
        console.log("Admin berhasil masuk");
      } else {
        socket.failedPins++;
        send(socket, { type: "auth", ok: false });

        if (socket.failedPins >= 5) {
          socket.close(1008, "Too many failed PIN attempts");
        }
      }

      return;
    }

    if (data.type === "set-lock-pin") {
      const pin = String(data.pin || "");
      if (!/^[0-9]{4,12}$/.test(pin)) {
        send(socket, {
          type:"lock-pin-status", ok:false,
          message:"PIN harus berupa 4–12 angka."
        });
        return;
      }
      screenLockPin = pin;
      send(socket, {
        type:"lock-pin-status", ok:true,
        message:"PIN simulasi berhasil disimpan di server."
      });
      return;
    }

    if (data.type === "screen-message") {
      const message = String(data.message || "").trim().slice(0, 300);
      if (!message) {
        send(socket, {
          type: "lock-pin-status",
          ok: false,
          message: "Pesan tidak boleh kosong."
        });
        return;
      }

      let sent = 0;
      const packet = { type: "screen-message", message };
      for (const client of wss.clients) {
        if (client.role === "target" &&
            client.readyState === WebSocket.OPEN) {
          send(client, packet);
          sent++;
        }
      }

      console.log("[SCREEN-MESSAGE] Pesan:", JSON.stringify(message),
                  "| target terhubung:", sent);
      send(socket, {
        type: "sent",
        effect: "screen-message",
        targets: sent
      });
      return;
    }

    if (data.type === "screen-lock" ||
        data.type === "screen-unlock") {

      let packet;

      if (data.type === "screen-lock") {
        const submittedPin = String(data.pin || "").trim();
        const customMessage = String(data.message || "").trim().slice(0, 300);

        if (!/^[0-9]{4,12}$/.test(submittedPin)) {
          send(socket, {
            type: "lock-pin-status", ok: false,
            message: "PIN harus berupa 4–12 angka."
          });
          return;
        }

        if (!customMessage) {
          send(socket, {
            type: "lock-pin-status", ok: false,
            message: "Pesan tidak boleh kosong."
          });
          return;
        }

        // PIN baru aktif ketika tombol KUNCI ditekan.
        screenLockPin = submittedPin;
        packet = { type: "screen-lock", message: customMessage };
        console.log("[SCREEN-LOCK] Pesan diterima:", JSON.stringify(customMessage));
      } else {
        packet = { type: "screen-unlock" };
      }

      let sent = 0;
      for (const client of wss.clients) {
        if (client.role === "target" &&
            client.readyState === WebSocket.OPEN) {
          send(client, packet);
          sent++;
        }
      }

      console.log("[SCREEN-LOCK] Pengiriman:", data.type, "| target terhubung:", sent);
      send(socket, {
        type: "sent",
        effect: data.type,
        targets: sent
      });
      return;
    }

    if (!allowedEffects.has(data.type)) return;

    const packet = { type: data.type };

    if (data.type === "custom") {
      packet.message = String(data.message || "").slice(0, 180);
    }

    if (data.type === "playuploaded") {
      packet.url = "/videos/shared-video.mp4";
    }

    let sentCount = 0;

    for (const client of wss.clients) {
      if (
        client.role === "target" &&
        client.readyState === WebSocket.OPEN
      ) {
        send(client, packet);
        sentCount++;
      }
    }

    send(socket, {
      type: "sent",
      effect: data.type,
      targets: sentCount
    });

    console.log("Efek:", data.type, "| target:", sentCount);
  });

  socket.on("close", () => {
    console.log("Browser terputus:", role);
    updateAdmins();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("RANGGACRYZHACK SERVER AKTIF");
  console.log("Target : http://127.0.0.1:" + PORT + "/target.html");
  console.log("Remote : http://127.0.0.1:" + PORT + "/remote.html");
  console.log("PIN admin ditetapkan melalui ADMIN_PIN.");
});

#!/usr/bin/env python3
"""
RIP Translator — Local Whisper Server
======================================

ติดตั้ง (ครั้งแรกครั้งเดียว):
  pip install faster-whisper flask flask-cors

รัน:
  python whisper_server.py

หมายเหตุ Windows: ต้องมี ffmpeg ใน PATH
  ดาวน์โหลด: https://www.gyan.dev/ffmpeg/builds/
  แตกไฟล์แล้วเพิ่ม bin/ เข้า Environment Variables → PATH

ขนาด Model (โหลดครั้งแรก):
  tiny    ~39 MB   เร็วที่สุด ความแม่นต่ำ
  base    ~74 MB   สมดุลดี  ← default
  small  ~244 MB  แม่นขึ้น
  medium ~769 MB  แม่นที่สุดสำหรับ CPU
"""

import os
import sys
import tempfile
from flask import Flask, request, jsonify
from flask_cors import CORS
from faster_whisper import WhisperModel

MODEL_SIZE = "base"  # change to "small" or "medium" for better accuracy

print(f"[RIP] Loading Whisper model '{MODEL_SIZE}' ...", flush=True)
print("[RIP] (first run downloads ~74 MB — please wait)", flush=True)
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
print("[RIP] Model ready!", flush=True)
print("[RIP] Server running at http://127.0.0.1:5000", flush=True)

app = Flask(__name__)
CORS(app)  # content scripts run under the page's origin (e.g. udemy.com), allow all


@app.route("/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file"}), 400

    audio_file = request.files["audio"]

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            beam_size=3,
            language=None,      # auto-detect language
            vad_filter=True,    # skip silence automatically
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return jsonify({"text": text, "language": info.language})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)

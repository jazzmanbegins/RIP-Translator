#!/usr/bin/env python3
"""
RIP Translator — Local Whisper Server
======================================

ติดตั้ง (ครั้งแรกครั้งเดียว):
  pip install faster-whisper flask flask-cors soundfile numpy

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

import io
import sys
import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify
from flask_cors import CORS
from faster_whisper import WhisperModel

MODEL_SIZE = "tiny"  # tiny=fastest (~39MB), base=balanced, small=accurate

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

    try:
        # Receive WAV (converted in browser) — no ffmpeg needed
        raw = io.BytesIO(request.files["audio"].read())
        audio, sr = sf.read(raw, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)  # stereo → mono

        segments, info = model.transcribe(
            audio,
            beam_size=1,                     # greedy — 3x faster than beam_size=3
            language=None,                   # auto-detect
            vad_filter=False,                # skip silence detection overhead
            condition_on_previous_text=False, # no hallucination, faster
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        return jsonify({"text": text, "language": info.language})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)

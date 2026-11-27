FROM python@sha256:191083cdf6c7bda8c76158983163ead5d5cf7b77cf3033e805bb0f5296f51b4b

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# YuNet из opencv_zoo (Apache-2.0), лицо: face_detection_yunet_2023mar.onnx.
COPY models/ /app/models/
COPY presence_check.py .

USER 1000
EXPOSE 8000
CMD ["python", "/app/presence_check.py"]

FROM python:3.13-alpine

ARG AUDIO_UID=1000
RUN apk add --no-cache ffmpeg pulseaudio-utils alsa-utils

WORKDIR /app
COPY server.py ./
COPY background_audio.py ./
COPY static ./static
RUN mkdir /recordings && chown ${AUDIO_UID}:${AUDIO_UID} /recordings

USER ${AUDIO_UID}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"

CMD ["python", "server.py"]

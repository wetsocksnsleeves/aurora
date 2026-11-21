"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DEVICE_KEY = "lightshow-laptop-camera";

export type CameraState = {
  stream: MediaStream | null;
  /** Video inputs, once permission is granted. */
  devices: { deviceId: string; label: string }[];
  deviceId: string | null;
  error: string | null;
  starting: boolean;
};

function readDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function writeDevice(id: string): void {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    // Not remembered; the default camera next time.
  }
}

/**
 * The laptop's camera for filming the crowd, with its microphone (left
 * unprocessed, so music isn't squashed). Off until `open`; the chosen
 * camera is remembered on this laptop.
 */
export function useCamera(): CameraState & {
  open: () => void;
  close: () => void;
  choose: (deviceId: string) => void;
} {
  const [state, setState] = useState<CameraState>({
    stream: null,
    devices: [],
    deviceId: null,
    error: null,
    starting: false,
  });
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const start = useCallback(async (deviceId: string | null) => {
    stopStream();
    setState((s) => ({ ...s, starting: true, error: null, stream: null }));
    const video: MediaTrackConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch {
      try {
        // No microphone, or the remembered camera is gone: video alone, any camera.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...video, deviceId: undefined },
        });
      } catch {
        setState((s) => ({
          ...s,
          starting: false,
          error: "Couldn’t open the camera. Allow camera access for this site.",
        }));
        return;
      }
    }
    streamRef.current = stream;
    const id = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
    if (id) writeDevice(id);
    let devices: CameraState["devices"] = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
    } catch {
      // No list: just this camera.
    }
    setState({ stream, devices, deviceId: id, error: null, starting: false });
  }, []);

  const open = useCallback(() => void start(readDevice()), [start]);
  const close = useCallback(() => {
    stopStream();
    setState((s) => ({ ...s, stream: null, starting: false }));
  }, []);
  const choose = useCallback(
    (deviceId: string) => {
      writeDevice(deviceId);
      void start(deviceId);
    },
    [start],
  );

  useEffect(() => () => stopStream(), []);
  return { ...state, open, close, choose };
}

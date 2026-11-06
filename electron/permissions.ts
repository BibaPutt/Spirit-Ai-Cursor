import { systemPreferences, shell } from 'electron';
import type { PermissionsStatus } from './types';
import { canCaptureScreen } from './capture/screenshot';

let cachedScreenRecording = false;

export async function getPermissions(): Promise<PermissionsStatus> {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
  if (!cachedScreenRecording) {
    cachedScreenRecording = await canCaptureScreen();
  }
  return { accessibility, screenRecording: cachedScreenRecording };
}

export function getPermissionsSync(): PermissionsStatus {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: cachedScreenRecording,
  };
}

export function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

export function resetScreenRecordingCache(): void {
  cachedScreenRecording = false;
}

export async function openSystemSettings(kind: 'accessibility' | 'screen-recording'): Promise<void> {
  if (process.platform !== 'darwin') return;
  const url =
    kind === 'accessibility'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  await shell.openExternal(url);
}

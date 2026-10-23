# Camera Link

An Expo starter with an Android phone receiver, a browser requester, and a small WebSocket signaling relay.

## Current behavior

- The phone generates and securely stores an 8-digit device number and a separate 16-character pairing key.
- The browser needs only the phone's 8-digit number to send a request.
- The phone displays an incoming request and requires a person to tap **Accept** or **Decline**.
- Camera permission is requested only after acceptance. The preview is visible on the phone and can be stopped there.
- This starter does not send camera video to the browser. It only relays the request and approval result.
- The phone app must be open and connected to the relay to receive requests; background delivery is not configured.

## Run locally

Use Node.js 22.13 or newer (required by Expo SDK 58).

1. Start the relay: `npm run relay`
2. Start Expo for web: `npm run web`
3. Start Expo for Android: `npm run android`
4. On the phone, note its generated number. Enter that number in the browser and send a request.

The default relay address is `ws://localhost:8787`, which works for the browser on the same computer. For a physical phone, point `EXPO_PUBLIC_SIGNALING_URL` at a reachable relay address before starting Expo. Use a secure WSS tunnel or deployment for device tests if the Android build blocks cleartext WebSockets.

## Deploy for internet access

The `render.yaml` Blueprint creates a public WebSocket relay and a static web app. Push this project to a GitHub repository, then in Render choose **New > Blueprint** and connect that repository. Render assigns HTTPS to the web app and WSS to the relay. The web app's relay hostname is wired automatically by the Blueprint.

For the Android APK, add `EXPO_PUBLIC_SIGNALING_HOST` to the Expo project's **preview** environment variables, using the relay's public hostname without `https://` (for example, `camera-link-relay.onrender.com`). Then build a new APK with `npx eas-cli build --platform android --profile preview`. The APK must be rebuilt whenever the public relay hostname changes.

Render's free web services may sleep when idle. The phone reconnects automatically with backoff, but it must remain open in the foreground to receive requests. This prototype keeps device registrations in memory, so a relay restart requires the phone app to reconnect; use a durable authenticated enrollment service before production use.

## APK build

This project uses Expo prebuild/EAS rather than checked-in native Android files. Install EAS CLI and configure an Expo account, set `EXPO_PUBLIC_SIGNALING_URL` to your reachable WSS relay URL, then run `npx eas-cli build --platform android --profile preview`. The Android SDK and Java are not installed in the original development environment, so a local APK build is not configured here.

## Security boundary

The relay is a development prototype: it keeps phone credentials in memory, has no account system, durable pairing, abuse controls, or TLS of its own. Do not expose it to the public internet or use real camera access with untrusted users. A production service needs WSS, authenticated device enrollment, revocable pairing, rate limiting, request audit/expiry, and a privacy review. A device number by itself is not authentication.
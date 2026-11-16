# Privacy Policy for Flipper for Google Meet™

Last updated: November 12, 2026

Flipper for Google Meet™ ("Flipper") is a Chrome extension with one function: it changes the direction (horizontal, vertical, or both) that a user's outgoing webcam video appears to other participants in a Google Meet call. The user's own self view in Meet is never changed.

## What Flipper processes

While a user is in a Google Meet call with their camera on, Flipper reads the live video frames of the outgoing camera track inside the Meet browser tab, draws a flipped copy of each frame, and hands that copy to the call in place of the original. This happens on the user's own device. The flipped video then reaches the other participants through Google Meet, in the same way the user's normal video would. Flipper itself never sends it anywhere.

While the Flipper popup is open during a call, it shows two small live preview tiles (the user's camera and what others currently see). To draw them, the Meet tab makes small, low-resolution still pictures from the same frames, several times per second, and passes them to the popup through Chrome's extension messaging, on the same device. The pictures are kept in memory only, are replaced by each newer picture, and are discarded when the popup is closed. They are shown only to the user, in the popup. Because the pictures travel through the Meet page's own message channel on the way to the popup, scripts already running on the Meet page could in principle observe them while the popup is open. Flipper does not send them anywhere itself.

Video frames and preview pictures are never written to disk.

## What Flipper stores

Flipper saves two settings with Chrome's built in `chrome.storage.local`: whether flipping is turned on, and which direction is selected. These settings stay on the user's device and exist only to restore the chosen setting the next time Meet or the popup is opened.

## What Flipper does not do

Flipper does not send video, audio, images, or settings to any server. It contains no network code of any kind: no analytics, no third party scripts loaded from the internet, no remote logging. This has been confirmed directly against the extension's source code, which contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or similar network call anywhere.

Apart from the two settings described above, nothing Flipper processes is retained. Flipper does not use cookies, does not run analytics, and cannot share data with any third party because it has no way to send data anywhere.

## Permissions

- **storage**: saves the on/off and direction preference locally on the device.
- **Host access to meet.google.com**: lets Flipper's scripts run on Google Meet, where the flipping takes place. Flipper does not run on, and has no access to, any other website.

## Screen sharing

Flipper recognizes screen, window and tab shares, both by recording every video track that Chrome's screen sharing picker hands to the page and by the markers Chrome puts on shared video, and does not flip them. Only camera video is affected.

## Chrome Web Store User Data Policy (Limited Use)

Flipper's use of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. In particular:

- Flipper uses camera video frames only to provide its single purpose: flipping the outgoing camera video and showing the preview in its popup.
- Flipper does not transfer user data to anyone. It has no way to.
- No person, including the developer, can read user data through Flipper, because Flipper never receives it.
- Flipper never uses or transfers user data for advertising, for determining creditworthiness or for lending, and never sells it.

## Children's privacy

Flipper is not directed at children. It does not collect or transmit personal data from a user of any age. It only processes camera video on the user's device during a call, as described above.

## Changes to this policy

If Flipper's data practices ever change, this policy will be updated first, and the entry in the Chrome Web Store developer dashboard will be kept consistent with this page.

## Contact

Questions about this policy can be sent to kenbuildsthings+extensions@gmail.com.

Google Meet is a trademark of Google LLC. Flipper is not affiliated with, endorsed by, or sponsored by Google.

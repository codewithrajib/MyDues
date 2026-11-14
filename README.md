# MyDues

A dark-mode ledger for managing each person's regular monthly dues, scheduled EMI plans, repayments, and net balance. Records are stored in Firebase Firestore and require Google sign-in.

## Enable Firestore sync

1. Create a Firebase project and register a web app.
2. Enable **Firestore Database** and **Authentication → Sign-in method → Google** in the Firebase console.
3. Copy the web app settings into `firebase-config.js`, replacing every `YOUR_...` placeholder.
4. Publish the rules in `firestore.rules` to your Firestore database.

Google sign-in is required before entering the app. A non-dismissible sign-in screen offers a Google button; the sign-in popup opens when the user clicks it. Firestore rules require Google authentication and restrict each Firebase user ID to its own records. People are stored at `users/{userId}/people/{personName}`; repayments remain under `users/{userId}/payments`. Regular dues and EMI plans are grouped under the person's readable ID, at `users/{userId}/dues/{personName}/records/{dueId}` and `users/{userId}/emis/{personName}/plans/{planId}`. The final document IDs allow multiple due entries and plans per person. Existing top-level dues and EMI records are moved to these paths when the account collections are loaded. Existing anonymous sessions are linked to Google on first sign-in where possible, preserving the Firebase user ID.

## Install and use offline

Serve MyDues over HTTPS (or localhost during development). The install icon beside the account button stays visible; on supported browsers it opens the native install prompt. If the prompt is unavailable or MyDues is already installed, the icon explains the available next step. Chrome on Android also offers **Install app** or **Add to Home screen** from its menu. The `manifest.json` file provides the standalone display and app icons; the service worker caches the app shell and Firebase modules.

After signing in online at least once, Firestore's persistent IndexedDB cache keeps records available offline and queues writes made without a connection. Changes appear immediately on the device and sync automatically when the connection returns; Firestore clears acknowledged pending writes. The local document cache remains available for later offline use. The browser must already have a valid signed-in Google session to use the app offline; first-time sign-in requires internet access.

Person documents are stored at `users/{userId}/people/{personName}`. The person name is the readable document ID (slashes are replaced with hyphens); repeated names receive a numbered suffix. Existing random-ID person documents are moved to name-based IDs when all account collections have been read from Firestore, and their dues, EMI plans, and repayment references are updated as part of the migration.

The Firebase web API key identifies the project; the Firestore security rules and authentication protect its data. Do not loosen the rules to public read/write access.

## Features

- Keeps a separate account for each person.
- Requires Google sign-in to read or save Firestore records; offline documents and pending writes use Firestore's persistent IndexedDB cache.
- Records monthly regular charges such as groceries, electricity, internet, and other expenses.
- Records the purchase date for each regular charge; EMI entries retain their scheduled EMI due date.
- Lets you edit or delete regular dues from a person's monthly account; changing a purchase date updates its statement month.
- Schedules EMI plans by purchase, calculates the monthly instalment, and adds each unpaid instalment during the selected term. An optional count of already-paid instalments prevents earlier EMIs from being billed again; processing fees apply only when the first instalment is still unpaid.
- Shows each person's EMI plans, instalments remaining, and scheduled amount remaining from the selected month.
- Records repayments against a person's account and calculates the running net balance after repayments.
- Lets you edit or delete regular dues, EMI plans, and repayments; account totals recalculate from the updated records.
- Creates a branded, person-specific monthly statement with account balances, purchases, EMI dates, and repayments (choose **Save as PDF** in the print dialog).

Regular dues are entered as monthly entries so amounts can change from month to month. EMI plans generate only the selected month's instalment from the EMI start date. **EMIs already given** reduces the number of instalments the app will schedule without delaying that start date; for example, 2 already given on a 12-month plan means 10 monthly instalments starting on the selected EMI start date. The count of already-paid instalments is not added to account totals, and the processing fee is not charged again. EMI remaining cards show scheduled instalments from the selected month onward, with active plans before completed ones. Repayments reduce the account balance but are not assigned to individual EMI plans. Repayments are applied to the selected statement month; any overpayment remains as a credit. No sample people or example records are loaded. When Firebase is configured, Firestore is the source of truth, with its persistent local cache providing offline access and sync.

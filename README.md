# MyDues

A dark-mode ledger for managing each person's regular monthly dues, scheduled EMI plans, repayments, and net balance. Records are stored in Firebase Firestore and require Google sign-in.

## Live Preview
https://codewithrajib.github.io/MyDues/

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

# Chit

Split a restaurant bill from a photo of the receipt. No accounts, no sign-in: everything runs in the browser and the current bill is saved locally.

## Run it

    ./run.sh

That serves the folder on port 5178 and prints a QR code. Scan it with your phone's camera (phone and Mac on the same Wi-Fi) and Chit opens in Safari. Tap Share, then Add to Home Screen, to launch it like an app.

If the phone can't load it, the Wi-Fi is probably isolating devices from each other (common on campus networks). Turn on your phone's hotspot, join it from the Mac, and run `./run.sh` again for a new address.

Receipt reading uses Tesseract.js from a CDN, so the first read needs an internet connection.

## How it works

1. **Receipt**: drop in a photo (or try the sample, or type it in). Chit reads the lines, then checks them against the printed subtotal and total. Fix anything on the paper; Enter finishes a field.
2. **Table**: add everyone. Each person gets a pen color. Mark who paid.
3. **Claim**: tap what you had. *Together* mode is one shared screen; *Pass the phone* has each person claim privately, then reveals only the lines that don't add up (unclaimed, double-claimed, or partly claimed multi-unit items), circled in red.
4. **Tip**: one person picks it. Pre-tax or post-tax base, split by what people ordered or evenly.
5. **Settle**: what everyone owes the payer, to the cent (largest-remainder rounding, so shares always sum exactly). Cover someone's share, mark people paid, copy a summary for the group chat.

## Live bills

On the Table step, tap **Start a live bill**. Chit makes a 5-character code and a link. Friends open the link (or tap "Join their bill with a code"), pick their name, and claim what they had on their own phone. Every phone sees the same receipt update live; the person picking the tip is the only one who can change it, and each phone's Settle screen says what that person owes.

Phones talk through [ntfy.sh](https://ntfy.sh), a free relay with no accounts. Each bill is a map of small facts (who claimed what, the tip, who paid); the newest write per fact wins, and phones already in the bill send a full snapshot to anyone who joins. Anyone who knows a code can read that bill, so treat codes like a group-chat link.

## Tests

    node --test tests/logic.test.mjs tests/stress.test.mjs

# Chit

Split a restaurant bill from a photo of the receipt. No accounts, no sign-in: everything runs in the browser and the current bill is saved locally.

## Run it

    ./run.sh

That serves the folder on port 5178 and prints a QR code. Scan it with your phone's camera (phone and Mac on the same Wi-Fi) and Chit opens in Safari. Tap Share, then Add to Home Screen, to launch it like an app.

If the phone can't load it, the Wi-Fi is probably isolating devices from each other (common on campus networks). Turn on your phone's hotspot, join it from the Mac, and run `./run.sh` again for a new address.

Receipt reading uses Tesseract.js from a CDN, so the first read needs an internet connection.

## How it works

1. **Receipt**: drop in a photo (or try the sample, or type it in). Chit reads the lines, then checks them against the printed subtotal and total. Fix anything on the paper; Enter finishes a field.
2. **Table**: add everyone, up to ten. Each person gets a pen color of their own. Mark who paid.
3. **Claim**: tap what you had. *Together* mode is one shared screen; *Pass the phone* has each person claim privately, then reveals only the lines that don't add up (unclaimed, double-claimed, or partly claimed multi-unit items), circled in red.
4. **Tip**: one person picks it. Pre-tax or post-tax base, split by what people ordered or evenly. A gratuity already charged on the receipt is read as the tip, so nobody is asked for a second one.
5. **Settle**: what everyone owes the payer, to the cent (largest-remainder rounding, so shares always sum exactly). Cover someone's share, mark people paid, copy a summary for the group chat.

## Tables you've had before

The same people eat together more than once, so Chit keeps the tables it has
seen. Leave the Table step with two or more people and that table is saved on
this device; next time it's a card on the Table step, and one tap seats
everybody again with the pens they had last time. Names you've used are offered
as you type, and × forgets a table. A table is remembered by who's in it, not by
when it happened, so the same five friends stay one card however often you eat.

Nothing about this leaves the phone: remembered tables sit in `localStorage`
beside the current bill, and clearing the site's data forgets them.

## Live bills

On the Table step, tap **Start a live bill**. Chit makes a 5-character code and a link. Friends open the link (or tap "Join their bill with a code"), pick their name, and claim what they had on their own phone. Every phone sees the same receipt update live; the person picking the tip is the only one who can change it, and each phone's Settle screen says what that person owes.

Phones talk through [ntfy.sh](https://ntfy.sh), a free relay with no accounts. Each bill is a map of small facts (who claimed what, the tip, who paid); the newest write per fact wins, and phones already in the bill send a full snapshot to anyone who joins. Anyone who knows a code can read that bill, so treat codes like a group-chat link.

## Tests

    node --test tests/logic.test.mjs tests/stress.test.mjs

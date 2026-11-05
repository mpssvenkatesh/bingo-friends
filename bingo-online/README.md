# 1–25 Bingo (live online)

Play bingo with up to 15 friends in two modes: 5 × 5 (numbers 1–25, strike BINGO) 7 × 7 (numbers 1–49, strike FRIENDS) or 10 × 10 (numbers 1–100, strike BINGO CHIPS). One person creates a room, shares the 4-letter code or invite link, and everyone plays live on their own phone. No accounts needed for players.

Files:
- `index.html`: the game page
- `app.js`: game logic
- `firebase-config.js`: your Firebase settings (you fill this in)
- `database.rules.json`: database rules to paste into Firebase

## Step 1: Set up Firebase (free, about 5 minutes)

Firebase keeps every player's screen in sync.

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Click **Create a project**, give it a name (for example `bingo-friends`), and finish the steps. You can turn off Google Analytics.
3. In the left menu, open **Build → Realtime Database** and click **Create Database**. Pick a location near you and choose **Start in locked mode**.
4. Open the **Rules** tab, delete what's there, paste the contents of `database.rules.json`, and click **Publish**.
5. Click the gear icon → **Project settings**. Under **Your apps**, click the web icon `</>`, give it a nickname, and click **Register app** (skip Firebase Hosting).
6. Firebase shows a `firebaseConfig` block. Copy its values into `firebase-config.js`, replacing each `PASTE_...` value.
   - Make sure `databaseURL` is filled in. If it's missing from the block, copy the URL shown at the top of the Realtime Database page (it ends in `firebaseio.com` or `firebasedatabase.app`).

## Step 2: Deploy on Vercel

Option A: with GitHub (easiest to update later)
1. Create a new GitHub repository and upload these files.
2. Go to https://vercel.com/new, import the repository, and click **Deploy**. No build settings are needed.

Option B: from your computer
1. Install Node.js, then run `npm i -g vercel`.
2. In this folder, run `vercel --prod` and follow the prompts.

Vercel gives you a link like `https://bingo-friends.vercel.app`. Share it with your friends.

## How to play

1. Everyone opens the link and types their name.
2. One person taps **Create room**, then **Copy invite** and sends it to friends (or just reads out the code).
3. Friends tap **Join room** with the code, or open the invite link directly.
4. The host picks the mode (5 × 5, 7 × 7 or 10 × 10). Everyone arranges their grid (Shuffle or Fill it myself) and taps **I'm ready**.
5. The host taps **Start game**. On your turn, tap a number to call it. It's struck on every grid.
6. Each full row, column or diagonal strikes one letter. Strike all of BINGO (5 lines), FRIENDS (7 lines) or BINGO CHIPS (10 lines) and tap the call button first to win.

## Good to know

- Anyone who knows a room code can join that room. Codes can't be listed or searched.
- The free Firebase plan easily covers games with friends (it allows 100 people connected at once).
- If someone leaves mid-game, the host can tap **Skip this turn** to keep going.

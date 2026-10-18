# Implant CRM – GitHub Pages setup (Master login only)

Files: index.html, style.css, app.js, config.js, firestore.rules, inventory_import.xlsx, customers_import.xlsx

## Step 1 – Firebase project (free)
1. https://console.firebase.google.com > Add project.
2. Build > **Firestore Database** > Create database > production mode > region (e.g. Mumbai).
3. Build > **Authentication** > Get started > Sign-in method > enable **Email/Password**.
4. Authentication > **Users** > Add user > enter YOUR email + a password. This is your login.

## Step 2 – Security rules
Firestore > Rules tab > paste `firestore.rules`, replace PASTE_YOUR_LOGIN_EMAIL with the email from Step 1.4 > Publish.
(Only that email can read/write data.)

## Step 3 – Config
Project settings > Your apps > Web (</>) > copy the config values into `config.js`.
Also: Authentication > Settings > Authorized domains > add `YOUR-USERNAME.github.io`.

## Step 4 – GitHub Pages
New repo > upload all files > Settings > Pages > Deploy from branch (main / root).
Open https://YOUR-USERNAME.github.io/REPO-NAME/ and sign in.

## Step 5 – Load your data
- Add / Import tab > upload `inventory_import.xlsx` (160 items with DP).
- CRM tab > Import Excel > `customers_import.xlsx` (120 doctors).
- PO / Invoice > supplier "Mechfix Implants": type the name, click "+ Save detail", and enter its address
  (Sur. No. 225, Plot No 32, Shreenathji Industrial Zone, Near Gundasara Railway Crossing, Rajkot 360311, 9904970778, info@mechfix.in).

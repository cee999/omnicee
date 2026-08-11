# Deployment notes — OMNICEE

This file shows quick steps to run OMNICEE 24/7 with `pm2` or `systemd`.

## Using pm2 (recommended for Node apps)

Install pm2 globally:

```bash
npm install -g pm2
```

Start the app using the existing PM2 ecosystem file:

```bash
# start with ecosystem
pm2 start ecosystem.config.js

# save process list for startup
pm2 save

# generate startup script (run the printed command as root)
pm2 startup
```

To check logs:

```bash
pm2 ls
pm2 logs omnicee --lines 200
```

To restart:

```bash
pm2 restart omnicee
```

## Using systemd

Create a service file `/etc/systemd/system/omnicee.service` with the following content (run as root):

```ini
[Unit]
Description=OMNICEE trading engine
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/omnicee
Environment=NODE_ENV=production
ExecStart=/usr/bin/node start-all.js
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable omnicee
sudo systemctl start omnicee
sudo journalctl -u omnicee -f
```

## Notes
- The repo already contains `ecosystem.config.js` which starts `start-all.js` (API + engine).
- For durable persistence enable MongoDB and set `MONGODB_URI` in your environment.
- The app now persists a lightweight market/candles cache to `.cache/` for faster cold starts.

*** End of file

📲 WhatsApp → WordPress Automation Tool

A Node.js-based automation tool that allows you to manage your WordPress blog posts directly from WhatsApp using the Baileys library.

Currently, the tool supports publishing and archiving WordPress posts via WhatsApp commands.

🚀 Features

✅ Publish WordPress posts via WhatsApp

✅ Archive (unpublish) posts via WhatsApp

🔒 Basic sender validation (currently works when sending messages to self)

⚡ Uses WordPress REST API

🔗 Powered by Baileys (WhatsApp Web API)

🛠 Tech Stack

Node.js

Baileys (WhatsApp Web API)

WordPress REST API

JavaScript

📦 How It Works

The tool listens for incoming WhatsApp messages using Baileys.

It parses commands from messages.

Based on the command, it triggers the WordPress REST API.

The post status is updated accordingly.

📌 Current Capabilities
Action	Supported
Publish Post	✅ Yes
Archive Post	✅ Yes
Edit Post	❌ Not Yet
Delete Post	❌ Not Yet
Multi-user Access	❌ Not Yet

⚙️ Setup

1️⃣ Clone the Repository

git clone https://github.com/Binyam888/WhatsApp-wp-bot.git

cd your-repo-name

2️⃣ Install Dependencies

npm install

3️⃣ Configure Environment Variables


Create a .env file:

WP_API_URL=https://yourwebsite.com/wp-json/wp/v2/posts

WP_USERNAME=your-username

WP_PASSWORD=your-application-password

4️⃣ Start the Server

node index.js


Scan the QR code with WhatsApp and you're ready to control your WordPress posts.

🔐 Authentication

This tool communicates with WordPress using:

WordPress Application Password
OR

Basic Authentication

Make sure your REST API access is properly secured.


📍 Project Status

🟢 Initial phase completed.
Core functionality (publish & archive) is working.

⚠️ Disclaimer

This project uses an unofficial WhatsApp Web API library (Baileys). Use responsibly and follow WhatsApp's terms of service.

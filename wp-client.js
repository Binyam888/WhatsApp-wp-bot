const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const https = require('https');
require('dotenv').config();

const agent = new https.Agent({ rejectUnauthorized: false });
const CONFIG_FILE = path.join(__dirname, 'config.json');

function getSites() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return [];
    }
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) return parsed;
        if (parsed.wpUrl) return [parsed];
    } catch (e) {
        console.error("Error reading config.json", e);
    }
    return [];
}

function saveConfig(wpUrl, username, password, clientIdentifier) {
    let sites = getSites();
    const index = sites.findIndex(s => s.wpUrl === wpUrl);
    if (index >= 0) {
        sites[index] = { wpUrl, username, password, clientIdentifier };
    } else {
        sites.push({ wpUrl, username, password, clientIdentifier });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sites, null, 2), 'utf8');
}

function getAuthHeader(site) {
    return `Basic ${Buffer.from(`${site.username}:${site.password}`).toString('base64')}`;
}

function normalize(url) {
    return url.replace(/\/$/, "");
}

async function verifyConnection(wpUrl, username, password) {
    try {
        const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        await axios.get(`${normalize(wpUrl)}/wp-json/wp/v2/types/post`, {
            headers: { 'Authorization': authHeader },
            httpsAgent: agent
        });
        return true;
    } catch (error) {
        throw error;
    }
}

async function uploadMedia(site, buffer, filename, mimeType) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename, contentType: mimeType });
        const response = await axios.post(`${normalize(site.wpUrl)}/wp-json/wp/v2/media`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': getAuthHeader(site),
                'Content-Disposition': `attachment; filename=${filename}`
            },
            httpsAgent: agent
        });
        return response.data.id;
    } catch (error) {
        throw error;
    }
}

async function createPost(site, title, content, status = 'publish', featuredMediaId = null) {
    try {
        const postData = {
            title: title,
            content: content,
            status: status,
            meta: { bot_created: true }
        };
        if (featuredMediaId) postData.featured_media = featuredMediaId;

        const response = await axios.post(`${normalize(site.wpUrl)}/wp-json/wp/v2/posts`, postData, {
            headers: {
                'Authorization': getAuthHeader(site),
                'Content-Type': 'application/json'
            },
            httpsAgent: agent
        });
        return response.data;
    } catch (error) { throw error; }
}

async function updatePost(site, postId, title, content, status) {
    try {
        const postData = {};
        if (title) postData.title = title;
        if (content) postData.content = content;
        if (status) postData.status = status;

        const response = await axios.post(`${normalize(site.wpUrl)}/wp-json/wp/v2/posts/${postId}`, postData, {
            headers: {
                'Authorization': getAuthHeader(site),
                'Content-Type': 'application/json'
            },
            httpsAgent: agent
        });
        return response.data;
    } catch (error) { throw error; }
}

async function deletePost(site, postId) {
    try {
        const response = await axios.delete(`${normalize(site.wpUrl)}/wp-json/wp/v2/posts/${postId}?force=true`, {
            headers: { 'Authorization': getAuthHeader(site) },
            httpsAgent: agent
        });
        return response.data;
    } catch (error) { throw error; }
}

module.exports = { getSites, uploadMedia, createPost, updatePost, deletePost, verifyConnection, saveConfig };

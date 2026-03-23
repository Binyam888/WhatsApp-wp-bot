const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
require('dotenv').config();

const CONFIG_FILE = path.join(__dirname, 'config.json');

function getAuthHeader() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error("WordPress credentials not configured. Please use the WP Plugin to configure the bot.");
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!config.wpUrl || !config.username || !config.password) {
        throw new Error("Incomplete WordPress credentials.");
    }
    return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
}

function getWpUrl() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error("WordPress credentials not configured.");
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return config.wpUrl.replace(/\/$/, ""); 
}

async function verifyConnection(wpUrl, username, password) {
    try {
        const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        const url = wpUrl.replace(/\/$/, "");
        
        // Ping WP API to test credentials
        await axios.get(`${url}/wp-json/wp/v2/types/post`, {
            headers: { 'Authorization': authHeader }
        });
        return true;
    } catch (error) {
        throw error;
    }
}

function saveConfig(wpUrl, username, password) {
    const config = { wpUrl, username, password };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function uploadMedia(buffer, filename, mimeType) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename, contentType: mimeType });

        const response = await axios.post(`${getWpUrl()}/wp-json/wp/v2/media`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': getAuthHeader(),
                'Content-Disposition': `attachment; filename=${filename}`
            }
        });

        console.log('Media uploaded:', response.data.id);
        return response.data.id;
    } catch (error) {
        console.error('Error uploading media:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function createPost(title, content, status = 'publish', featuredMediaId = null) {
    try {
        const postData = {
            title: title,
            content: content,
            status: status,
            meta: {
                _created_by_bot: true
            }
        };

        if (featuredMediaId) {
            postData.featured_media = featuredMediaId;
        }

        const response = await axios.post(`${getWpUrl()}/wp-json/wp/v2/posts`, postData, {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });

        console.log('Post created:', response.data.link);
        return response.data;
    } catch (error) {
        console.error('Error creating post:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function updatePost(postId, title, content, status) {
    try {
        const postData = {};
        if (title) postData.title = title;
        if (content) postData.content = content;
        if (status) postData.status = status;

        const response = await axios.post(`${getWpUrl()}/wp-json/wp/v2/posts/${postId}`, postData, {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        });

        console.log('Post updated:', response.data.link);
        return response.data;
    } catch (error) {
        console.error('Error updating post:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function deletePost(postId) {
    try {
        const response = await axios.delete(`${getWpUrl()}/wp-json/wp/v2/posts/${postId}?force=true`, {
            headers: {
                'Authorization': getAuthHeader()
            }
        });

        console.log('Post deleted:', postId);
        return response.data;
    } catch (error) {
        console.error('Error deleting post:', error.response ? error.response.data : error.message);
        throw error;
    }
}

module.exports = { uploadMedia, createPost, updatePost, deletePost, verifyConnection, saveConfig };

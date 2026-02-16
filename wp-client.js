const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
require('dotenv').config();

const wpUrl = process.env.WP_URL;
const wpUsername = process.env.WP_USERNAME;
const wpPassword = process.env.WP_APP_PASSWORD;

const authHeader = `Basic ${Buffer.from(`${wpUsername}:${wpPassword}`).toString('base64')}`;

async function uploadMedia(buffer, filename, mimeType) {
    try {
        const formData = new FormData();
        formData.append('file', buffer, { filename, contentType: mimeType });

        const response = await axios.post(`${wpUrl}/wp-json/wp/v2/media`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': authHeader,
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
            status: status
        };

        if (featuredMediaId) {
            postData.featured_media = featuredMediaId;
        }

        const response = await axios.post(`${wpUrl}/wp-json/wp/v2/posts`, postData, {
            headers: {
                'Authorization': authHeader,
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

module.exports = { uploadMedia, createPost };

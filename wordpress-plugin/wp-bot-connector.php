<?php
/**
 * Plugin Name: WP Telegram Bot Connector
 * Plugin URI: https://example.com/
 * Description: A basic plugin providing connectivity for the external Telegram Node.js bot to interact via advanced hooks (if needed). Currently, the bot uses the standard WordPress REST API, so this acts as a placeholder or settings scaffold.
 * Version: 1.0.0
 * Author: Your Name
 * License: GPL v2 or later
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Exit if accessed directly.
}

// Example: Expose a custom endpoint for the bot to ping WP
add_action('rest_api_init', function () {
    register_rest_route('wp-telegram-bot/v1', '/ping', array(
        'methods' => 'GET',
        'callback' => 'wp_telegram_bot_ping',
        'permission_callback' => '__return_true'
    ));
});

function wp_telegram_bot_ping() {
    return new WP_REST_Response(array('status' => 'success', 'message' => 'WordPress is ready.'), 200);
}

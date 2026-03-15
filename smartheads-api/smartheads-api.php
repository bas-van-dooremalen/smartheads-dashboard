<?php
/*
Plugin Name: Smartheads Dashboard Update API
Description: Beveiligde API voor Smartheads Dashboard om versies (PHP/Core/Theme/Plugins) uit te lezen.
Version: 3.4
Author: Bas / Smartheads
*/

if (!defined('ABSPATH')) exit;

// -----------------------------------------------------------------------------
// Configuratie (simpel)
// -----------------------------------------------------------------------------

define('SH_DASHBOARD_API_KEY',   'f9e1c4b7a3d8f0c2e6b1a9d4f7c3e8a1b6d9f2c4e7a0b3d5f8c1e4a7b2d9f3c6e1a4b7d0f2c9e5a1d4b8f0c3e6a9d2f5b1c7e4a0f8d3');
define('SH_LEGACY_CRON_HOOK',    'sh_run_http_health_check');

// -----------------------------------------------------------------------------
// Cleanup legacy (HTTP health / offline log)
// -----------------------------------------------------------------------------

register_activation_hook(__FILE__, 'sh_cleanup_legacy_cron_and_options');
register_deactivation_hook(__FILE__, 'sh_cleanup_legacy_cron_and_options');

function sh_cleanup_legacy_cron_and_options(): void {
    $timestamp = wp_next_scheduled(SH_LEGACY_CRON_HOOK);
    if ($timestamp) {
        wp_unschedule_event($timestamp, SH_LEGACY_CRON_HOOK);
    }

    delete_option('sh_cached_http_health');
    delete_option('sh_offline_log');
}
add_action('init', 'sh_cleanup_legacy_cron_and_options');

// -----------------------------------------------------------------------------
// REST route
// -----------------------------------------------------------------------------

add_action('rest_api_init', function(): void {
    register_rest_route('dashboard/v1', '/updates', [
        'methods'             => 'GET',
        'callback'            => 'sh_dashboard_update_api_callback',
        'permission_callback' => '__return_true',
    ]);
});

// -----------------------------------------------------------------------------
// CORS headers
// -----------------------------------------------------------------------------

add_action('rest_api_init', function(): void {
    remove_filter('rest_pre_serve_request', 'rest_send_cors_headers');
    add_filter('rest_pre_serve_request', function($value) {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET');
        header('Access-Control-Allow-Credentials: true');
        return $value;
    });
}, 15);

// -----------------------------------------------------------------------------
// API callback
// -----------------------------------------------------------------------------

function sh_dashboard_update_api_callback(WP_REST_Request $request): WP_REST_Response {

    if ($request->get_param('key') !== SH_DASHBOARD_API_KEY) {
        return new WP_REST_Response(['error' => 'Unauthorized', 'message' => 'Ongeldige API Key.'], 401);
    }

    try {
        /* ---------- Versions (simple) ---------- */
        $php_version  = defined('PHP_VERSION') ? PHP_VERSION : phpversion();
        $core_version = get_bloginfo('version');

        $active_theme = wp_get_theme();
        $themes = [];
        if ($active_theme && $active_theme->exists()) {
            $themes[] = [
                'name'         => (string) $active_theme->get('Name'),
                'version'      => (string) $active_theme->get('Version'),
                'needs_update' => false,
                'active'       => true,
            ];
        }

        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        $all_plugins    = function_exists('get_plugins') ? get_plugins() : [];
        $active_plugins = (array) get_option('active_plugins', []);
        $plugins = [];
        foreach ($active_plugins as $plugin_file) {
            $info = isset($all_plugins[$plugin_file]) ? $all_plugins[$plugin_file] : null;
            $plugins[] = [
                'name'         => $info ? (string) ($info['Name'] ?? $plugin_file) : (string) $plugin_file,
                'version'      => $info ? (string) ($info['Version'] ?? '') : '',
                'needs_update' => false,
                'active'       => true,
            ];
        }

        /* ---------- Response ---------- */
        return new WP_REST_Response([
            'site'    => get_bloginfo('name'),
            'php'     => $php_version,
            'core'    => [
                'current'      => (string) $core_version,
                'needs_update' => false,
            ],
            'themes'  => $themes,
            'plugins' => $plugins,
            'last_check_timestamp' => time(),
        ], 200);

    } catch (Exception $e) {
        return new WP_REST_Response(['error' => $e->getMessage()], 500);
    }
}

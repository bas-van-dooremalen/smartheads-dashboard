<?php
/*
Plugin Name: Smartheads Dashboard Update API
Description: Beveiligde API voor Smartheads Dashboard om HTTP health en offline history uit te lezen.
Version: 3.3
Author: Bas / Smartheads
*/

if (!defined('ABSPATH')) exit;

// -----------------------------------------------------------------------------
// Configuratie
// -----------------------------------------------------------------------------

define('SH_DASHBOARD_API_KEY',   'f9e1c4b7a3d8f0c2e6b1a9d4f7c3e8a1b6d9f2c4e7a0b3d5f8c1e4a7b2d9f3c6e1a4b7d0f2c9e5a1d4b8f0c3e6a9d2f5b1c7e4a0f8d3');
define('SH_MONITOR_POST_TYPES',  ['page', 'post']);
define('SH_OFFLINE_LOG_MAX',     50);
define('SH_HTTP_MAX_URLS',       50);
define('SH_HTTP_TIMEOUT',        8);
define('SH_CRON_HOOK',           'sh_run_http_health_check');
define('SH_CRON_INTERVAL',       'sh_every_30_minutes');

// -----------------------------------------------------------------------------
// Activatie / deactivatie
// -----------------------------------------------------------------------------

register_activation_hook(__FILE__, 'sh_plugin_activate');
register_deactivation_hook(__FILE__, 'sh_plugin_deactivate');

function sh_plugin_activate(): void {
    sh_schedule_cron();
    sh_run_and_cache_http_health();
}

function sh_plugin_deactivate(): void {
    $timestamp = wp_next_scheduled(SH_CRON_HOOK);
    if ($timestamp) {
        wp_unschedule_event($timestamp, SH_CRON_HOOK);
    }
}

// -----------------------------------------------------------------------------
// Custom cron interval
// -----------------------------------------------------------------------------

add_filter('cron_schedules', function(array $schedules): array {
    $schedules[SH_CRON_INTERVAL] = [
        'interval' => 30 * MINUTE_IN_SECONDS,
        'display'  => 'Elke 30 minuten',
    ];
    return $schedules;
});

// -----------------------------------------------------------------------------
// Cron planning
// -----------------------------------------------------------------------------

function sh_schedule_cron(): void {
    if (!wp_next_scheduled(SH_CRON_HOOK)) {
        wp_schedule_event(time(), SH_CRON_INTERVAL, SH_CRON_HOOK);
    }
}
add_action('init', 'sh_schedule_cron');
add_action(SH_CRON_HOOK, 'sh_run_and_cache_http_health');

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
// Helper: offline log
// -----------------------------------------------------------------------------

function sh_get_offline_log(): array {
    return get_option('sh_offline_log', []);
}

function sh_append_offline_log(string $url, int $status_code, string $reason): void {
    $log   = sh_get_offline_log();
    $log[] = [
        'url'         => $url,
        'timestamp'   => time(),
        'status_code' => $status_code,
        'reason'      => $reason,
    ];

    if (count($log) > SH_OFFLINE_LOG_MAX) {
        $log = array_slice($log, -SH_OFFLINE_LOG_MAX);
    }

    update_option('sh_offline_log', $log, false);
}

function sh_is_ssl_error_message(string $message): bool {
    $m = strtolower($message);
    return strpos($m, 'ssl certificate problem') !== false
        || strpos($m, 'unable to get local issuer certificate') !== false
        || strpos($m, 'unable to verify the first certificate') !== false;
}

// -----------------------------------------------------------------------------
// Async HTTP health check (via WP Cron)
// -----------------------------------------------------------------------------

function sh_run_and_cache_http_health(): void {
    @set_time_limit(300);

    $http_checks = [];
    $has_errors  = false;
    $error_count = 0;

    $all_posts = get_posts([
        'post_type'      => SH_MONITOR_POST_TYPES,
        'post_status'    => 'publish',
        'posts_per_page' => -1,
        'fields'         => 'ids',
    ]);

    $urls_to_check = [home_url('/')];
    foreach ($all_posts as $post_id) {
        $permalink = get_permalink($post_id);
        if ($permalink && !in_array($permalink, $urls_to_check, true)) {
            $urls_to_check[] = $permalink;
        }
    }

    $total_available = count($urls_to_check);
    $urls_to_check   = array_slice($urls_to_check, 0, SH_HTTP_MAX_URLS);

    foreach ($urls_to_check as $url) {
        $start_time = microtime(true);

        $response = wp_remote_get($url, [
            'timeout'     => SH_HTTP_TIMEOUT,
            'redirection' => 5,        // Volg redirects â€” 301/302 zijn geen fouten
            'sslverify'   => false,    // Blokkeer niet op SSL-waarschuwingen bij de check zelf
            'user-agent'  => 'Smartheads-Dashboard-Monitor/3.1',
            'headers'     => [
                'Cache-Control' => 'no-cache',
                'Pragma'        => 'no-cache',
            ],
        ]);

        $response_time_ms = (int) round((microtime(true) - $start_time) * 1000);

        if (is_wp_error($response)) {
            $status      = 0;
            $status_text = $response->get_error_message();

            // SSL-chain errors tell us the server is probably up, but the local CA store is incomplete.
            // For a simple online/offline view we don't want to mark this as "offline".
            $is_error = !sh_is_ssl_error_message($status_text);
        } else {
            $status      = (int) wp_remote_retrieve_response_code($response);
            $status_text = wp_remote_retrieve_response_message($response);

            // Wat telt als echte fout:
            // 5xx = serverfout          â†’ altijd een echte fout
            // 404 = pagina niet gevonden â†’ echte fout (inhoud verdwenen)
            // 403 = toegang geweigerd   â†’ echte fout
            // 0   = geen verbinding     â†’ echte fout
            // 301/302 â†’ worden gevolgd (redirection: 5), tellen NIET als fout
            // 200-299 â†’ alles in orde
            $is_error = ($status === 0)
                     || ($status >= 500)
                     || ($status === 404)
                     || ($status === 403);
        }

        if ($is_error) {
            $has_errors = true;
            $error_count++;
            sh_append_offline_log($url, $status, $status_text ?: 'Onbekende fout');
        }

        $http_checks[] = [
            'url'              => $url,
            'post_id'          => url_to_postid($url) ?: null,
            'status_code'      => $status,
            'status_text'      => $status_text,
            'response_time_ms' => $response_time_ms,
            'ok'               => ($status >= 200 && $status < 300),
            'is_redirect'      => ($status >= 300 && $status < 400),
            'is_error'         => $is_error,
        ];
    }

    // Sorteer: fouten bovenaan, dan traagste eerst
    usort($http_checks, function(array $a, array $b): int {
        if ($a['is_error'] !== $b['is_error']) {
            return $b['is_error'] <=> $a['is_error'];
        }
        return $b['response_time_ms'] <=> $a['response_time_ms'];
    });

    $result = [
        'has_errors'      => $has_errors,
        'error_count'     => $error_count,
        'total_checked'   => count($http_checks),
        'total_available' => $total_available,
        'checks'          => $http_checks,
        'last_run'        => time(),
    ];

    update_option('sh_cached_http_health', $result, false);
}

// -----------------------------------------------------------------------------
// API callback
// -----------------------------------------------------------------------------

function sh_dashboard_update_api_callback(WP_REST_Request $request): WP_REST_Response {

    if ($request->get_param('key') !== SH_DASHBOARD_API_KEY) {
        return new WP_REST_Response(['error' => 'Unauthorized', 'message' => 'Ongeldige API Key.'], 401);
    }

    try {
        $force_check = $request->get_param('force') === '1';
        if ($force_check) {
            sh_run_and_cache_http_health();
        }

        /* ---------- HTTP HEALTH (uit cache) ---------- */
        $cached_http_health = get_option('sh_cached_http_health', null);

        if ($cached_http_health === null) {
            wp_schedule_single_event(time(), SH_CRON_HOOK);
            $cached_http_health = [
                'has_errors'      => false,
                'error_count'     => 0,
                'total_checked'   => 0,
                'total_available' => 0,
                'checks'          => [],
                'last_run'        => null,
            ];
        }

        /* ---------- OFFLINE LOG ---------- */
        $raw_log     = sh_get_offline_log();
        $offline_log = array_map(function(array $entry): array {
            $entry['date'] = date('Y-m-d H:i:s', $entry['timestamp']);
            return $entry;
        }, array_reverse($raw_log));

        /* ---------- Response ---------- */
        return new WP_REST_Response([
            'site'    => get_bloginfo('name'),
            'http_health' => $cached_http_health,
            'offline_log' => [
                'total_events' => count($raw_log),
                'events'       => $offline_log,
            ],
            'last_check_timestamp' => time(),
        ], 200);

    } catch (Exception $e) {
        return new WP_REST_Response(['error' => $e->getMessage()], 500);
    }
}

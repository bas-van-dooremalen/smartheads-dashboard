<?php
/*
Plugin Name: Smartheads Dashboard Update API
Description: Beveiligde API voor Smartheads Dashboard om versies (PHP/Core/Theme/Plugins) en updatestatus uit te lezen.
Version: 4.0
Author: Bas / Smartheads
*/

if ( ! defined( 'ABSPATH' ) ) exit;

// =============================================================================
// Configuratie
// =============================================================================

define( 'SH_DASHBOARD_API_KEY', 'f9e1c4b7a3d8f0c2e6b1a9d4f7c3e8a1b6d9f2c4e7a0b3d5f8c1e4a7b2d9f3c6e1a4b7d0f2c9e5a1d4b8f0c3e6a9d2f5b1c7e4a0f8d3' );
define( 'SH_LEGACY_CRON_HOOK',  'sh_run_http_health_check' );

// =============================================================================
// Cleanup: verwijder legacy cron & opgeslagen opties bij activatie/deactivatie
// =============================================================================

register_activation_hook( __FILE__, 'sh_cleanup_legacy' );
register_deactivation_hook( __FILE__, 'sh_cleanup_legacy' );

function sh_cleanup_legacy(): void {
    $timestamp = wp_next_scheduled( SH_LEGACY_CRON_HOOK );
    if ( $timestamp ) {
        wp_unschedule_event( $timestamp, SH_LEGACY_CRON_HOOK );
    }
    delete_option( 'sh_cached_http_health' );
    delete_option( 'sh_offline_log' );
}
add_action( 'init', 'sh_cleanup_legacy' );

// =============================================================================
// REST route: GET /wp-json/dashboard/v1/updates
// =============================================================================

add_action( 'rest_api_init', function (): void {
    register_rest_route( 'dashboard/v1', '/updates', [
        'methods'             => 'GET',
        'callback'            => 'sh_dashboard_update_api_callback',
        'permission_callback' => '__return_true',
    ] );
} );

// =============================================================================
// CORS
// =============================================================================

add_action( 'rest_api_init', function (): void {
    remove_filter( 'rest_pre_serve_request', 'rest_send_cors_headers' );
    add_filter( 'rest_pre_serve_request', function ( $value ) {
        header( 'Access-Control-Allow-Origin: *' );
        header( 'Access-Control-Allow-Methods: GET' );
        header( 'Access-Control-Allow-Credentials: true' );
        return $value;
    } );
}, 15 );

// =============================================================================
// Hulpfunctie: zorg dat WordPress update-data beschikbaar is
// =============================================================================

function sh_ensure_update_data(): void {
    if ( ! function_exists( 'get_plugins' ) ) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    if ( ! function_exists( 'wp_update_plugins' ) ) {
        require_once ABSPATH . 'wp-includes/update.php';
    }

    if ( ! get_site_transient( 'update_core' ) )    { wp_version_check(); }
    if ( ! get_site_transient( 'update_themes' ) )  { wp_update_themes(); }
    if ( ! get_site_transient( 'update_plugins' ) ) { wp_update_plugins(); }
}

// =============================================================================
// API callback
// =============================================================================

function sh_dashboard_update_api_callback( WP_REST_Request $request ): WP_REST_Response {

    if ( $request->get_param( 'key' ) !== SH_DASHBOARD_API_KEY ) {
        return new WP_REST_Response(
            [ 'error' => 'Unauthorized', 'message' => 'Ongeldige API Key.' ],
            401
        );
    }

    try {
        sh_ensure_update_data();

        // ── PHP versie ──────────────────────────────────────────────────────
        $php_version         = PHP_VERSION;
        $php_min_recommended = '8.1.0';
        $php_needs_update    = version_compare( $php_version, $php_min_recommended, '<' );

        // ── WordPress Core ──────────────────────────────────────────────────
        global $wp_version;
        $core_current      = $wp_version;
        $update_core       = get_site_transient( 'update_core' );
        $core_new_version  = null;
        $core_needs_update = false;

        if ( ! empty( $update_core->updates ) ) {
            foreach ( $update_core->updates as $update ) {
                if ( isset( $update->response ) && $update->response === 'upgrade' ) {
                    $core_new_version  = $update->version ?? null;
                    $core_needs_update = true;
                    break;
                }
            }
        }

        // ── Actief thema ────────────────────────────────────────────────────
        $active_theme  = wp_get_theme();
        $update_themes = get_site_transient( 'update_themes' );
        $themes        = [];

        if ( $active_theme && $active_theme->exists() ) {
            $theme_slug         = $active_theme->get_stylesheet();
            $theme_needs_update = isset( $update_themes->response[ $theme_slug ] );
            $theme_new_version  = $theme_needs_update
                ? ( $update_themes->response[ $theme_slug ]['new_version'] ?? null )
                : null;

            $themes[] = [
                'name'         => (string) $active_theme->get( 'Name' ),
                'version'      => (string) $active_theme->get( 'Version' ),
                'needs_update' => $theme_needs_update,
                'new_version'  => $theme_new_version,
                'active'       => true,
            ];
        }

        // ── Actieve plugins ─────────────────────────────────────────────────
        $all_plugins    = get_plugins();
        $active_plugins = (array) get_option( 'active_plugins', [] );
        $update_plugins = get_site_transient( 'update_plugins' );
        $plugins        = [];

        foreach ( $active_plugins as $plugin_file ) {
            $info                = $all_plugins[ $plugin_file ] ?? null;
            $plugin_needs_update = isset( $update_plugins->response[ $plugin_file ] );
            $plugin_new_version  = $plugin_needs_update
                ? ( $update_plugins->response[ $plugin_file ]->new_version ?? null )
                : null;

            $plugins[] = [
                'name'         => $info ? (string) ( $info['Name']    ?? $plugin_file ) : (string) $plugin_file,
                'version'      => $info ? (string) ( $info['Version'] ?? '' )           : '',
                'needs_update' => $plugin_needs_update,
                'new_version'  => $plugin_new_version,
                'active'       => true,
            ];
        }

        // ── Samenvatting ────────────────────────────────────────────────────
        $summary = [
            'core_updates'   => $core_needs_update ? 1 : 0,
            'theme_updates'  => count( array_filter( $themes,  fn( $t ) => $t['needs_update'] ) ),
            'plugin_updates' => count( array_filter( $plugins, fn( $p ) => $p['needs_update'] ) ),
        ];
        $summary['total_updates'] = array_sum( $summary );

        return new WP_REST_Response( [
            'site'    => get_bloginfo( 'name' ),
            'php'     => [
                'version'      => $php_version,
                'needs_update' => $php_needs_update,
                'recommended'  => $php_min_recommended,
            ],
            'core'    => [
                'current'      => $core_current,
                'needs_update' => $core_needs_update,
                'new_version'  => $core_new_version,
            ],
            'themes'  => $themes,
            'plugins' => $plugins,
            'summary' => $summary,
            'last_check_timestamp' => time(),
        ], 200 );

    } catch ( Exception $e ) {
        return new WP_REST_Response( [ 'error' => $e->getMessage() ], 500 );
    }
}
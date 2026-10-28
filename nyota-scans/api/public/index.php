<?php
declare(strict_types=1);

use Nyota\{Config, Router, Http, HttpError};
use Nyota\{AuthController, CatalogController, LibraryController, PaymentController, CreatorController, AdminController};

$root = dirname(__DIR__);
require $root . '/src/Core.php';
require $root . '/src/FeexPay.php';
require $root . '/src/Controllers.php';
Config::load($root . '/.env');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// Fichiers téléversés (serveur PHP intégré / dev). En production, servez /uploads via nginx.
if (str_starts_with($path, '/uploads/')) {
    $file = realpath($root . '/storage' . $path);
    if ($file && str_starts_with($file, realpath($root . '/storage/uploads')) && is_file($file)) {
        header('Content-Type: ' . (new finfo(FILEINFO_MIME_TYPE))->file($file));
        header('Cache-Control: public, max-age=31536000, immutable');
        readfile($file);
        exit;
    }
    http_response_code(404);
    exit;
}

$origin = Config::get('WEB_ORIGIN', 'http://localhost:3000');
header("Access-Control-Allow-Origin: $origin");
header('Vary: Origin');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

$r = new Router();
$r->add('GET', '/', fn() => ['name' => 'Nyota Scans API', 'by' => 'Starlight Network']);
$r->add('POST', '/auth/register', fn() => AuthController::register());
$r->add('POST', '/auth/login', fn() => AuthController::login());
$r->add('GET', '/me', fn() => AuthController::me());

$r->add('GET', '/home', fn() => CatalogController::home());
$r->add('GET', '/genres', fn() => CatalogController::genres());
$r->add('GET', '/series', fn() => CatalogController::browse());
$r->add('GET', '/series/{slug}', fn($a) => CatalogController::show($a));
$r->add('GET', '/chapters/{id}', fn($a) => CatalogController::chapter($a));

$r->add('GET', '/library', fn() => LibraryController::index());
$r->add('POST', '/favorites/{id}', fn($a) => LibraryController::addFavorite($a));
$r->add('DELETE', '/favorites/{id}', fn($a) => LibraryController::removeFavorite($a));
$r->add('POST', '/chapters/{id}/progress', fn($a) => LibraryController::progress($a));

$r->add('GET', '/plans', fn() => PaymentController::plans());
$r->add('POST', '/payments/checkout', fn() => PaymentController::checkout());
$r->add('GET', '/payments/{ref}', fn($a) => PaymentController::status($a));
$r->add('POST', '/payments/webhook', fn() => PaymentController::webhook());

$r->add('GET', '/creator/series', fn() => CreatorController::mySeries());
$r->add('POST', '/creator/series', fn() => CreatorController::createSeries());
$r->add('POST', '/creator/series/{id}/submit', fn($a) => CreatorController::submit($a));
$r->add('POST', '/creator/series/{id}/cover', fn($a) => CreatorController::uploadCover($a));
$r->add('POST', '/creator/series/{id}/chapters', fn($a) => CreatorController::addChapter($a));

$r->add('GET', '/admin/stats', fn() => AdminController::stats());
$r->add('GET', '/admin/series', fn() => AdminController::queue());
$r->add('POST', '/admin/series/{id}/status', fn($a) => AdminController::setStatus($a));

try {
    $r->dispatch($_SERVER['REQUEST_METHOD'] ?? 'GET', rtrim($path, '/') ?: '/');
} catch (HttpError $e) {
    Http::json(['error' => $e->getMessage()] + $e->extra, $e->status);
} catch (Throwable $e) {
    error_log((string) $e);
    Http::json(['error' => Config::get('APP_ENV') === 'local' ? $e->getMessage() : 'Erreur serveur'], 500);
}

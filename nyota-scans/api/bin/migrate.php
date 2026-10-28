<?php
// Usage: php bin/migrate.php [--seed]
declare(strict_types=1);
require dirname(__DIR__) . '/src/Core.php';
Nyota\Config::load(dirname(__DIR__) . '/.env');

$pdo = Nyota\Db::pdo();
$sql = file_get_contents(dirname(__DIR__) . '/database/schema.sql');
foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
    if (!preg_match('/^(--.*\n)*\s*$/', $stmt)) $pdo->exec($stmt);
}
echo "Schéma appliqué.\n";
if (in_array('--seed', $argv, true)) {
    require __DIR__ . '/seed.php';
}

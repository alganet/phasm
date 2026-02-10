<?php

// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

echo "PHP version: " . phpversion() . "\n\n";

foreach (get_loaded_extensions() as $ext) {
    echo "Loaded extension: $ext\n";
}

echo "\n";

$zip = new ZipArchive();
$filename = "./vendor.zip";
$zip->open($filename, ZipArchive::CREATE);
$zip->extractTo('./');
$zip->close();

require 'vendor/autoload.php';

foreach (scandir('./vendor') as $dir) {
    if ($dir === '.' || $dir === '..') {
        continue;
    }
    $subdir = "./vendor/$dir";
    if (is_dir($subdir)) {
        foreach (scandir($subdir) as $subsubdir) {
            if ($subsubdir === '.' || $subsubdir === '..') {
                continue;
            }
            $path = "$subdir/$subsubdir";
            if (is_dir($path)) {
                echo "$path\n";
            }
        }
    }
}
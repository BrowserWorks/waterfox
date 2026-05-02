# Contributing to Foxxite / Contribuer à Foxxite

**[EN]** Welcome to the Foxxite development guide! This document outlines how to compile and contribute to the project.
**[FR]** Bienvenue dans le guide de développement Foxxite ! Ce document explique comment compiler et contribuer au projet.

## 🏗️ Build Guide / Guide de Compilation

Foxxite uses specific flags (`-march=native`, `-O3`, LTO, PGO) to ensure maximum performance on the compiling machine.

### Desktop (Windows / Linux)

**[EN] Commands:**
1. Bootstrap the environment: `./mach bootstrap`
2. Ensure you have the modified `.mozconfig-x86_64-pc-windows-msvc` (or linux) in the root directory.
3. Build the browser: `./mach build`
4. Run the browser: `./mach run`
5. Package the installer: `./mach package`

**[FR] Commandes :**
1. Initialiser l'environnement : `./mach bootstrap`
2. Assurez-vous d'avoir le fichier `.mozconfig-x86_64-pc-windows-msvc` (ou linux) modifié à la racine.
3. Compiler le navigateur : `./mach build`
4. Lancer le navigateur : `./mach run`
5. Créer l'installeur : `./mach package`

### Mobile (Android)

**[EN] Commands:**
Foxxite Android supports universal architectures (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`). No features are disabled.
1. Build GeckoView: `./mach build`
2. Assemble the APK: `./gradlew assembleRelease`

**[FR] Commandes :**
L'Android Foxxite supporte les architectures universelles. Aucune fonctionnalité n'est désactivée.
1. Compiler GeckoView : `./mach build`
2. Assembler l'APK : `./gradlew assembleRelease`

## 🗂 Architecture Changes / Modifications de l'Architecture

- `/cloud-backend`: Cloudflare Workers & Durable objects sync API.
- `mobile/android/foxxite-vpn`: Native Wireguard integration foreground service.
- `mobile/android/foxxite-widgets`: Live monitoring widgets.
- `browser/components/foxxite-adaptive-ui`: Dynamic CSS injection.

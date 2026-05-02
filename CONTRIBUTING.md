# Contributing to Foxxite / Contribuer à Foxxite

**[EN]** Welcome to the Foxxite development guide! This document outlines how to compile and contribute to the project.
**[FR]** Bienvenue dans le guide de développement Foxxite ! Ce document explique comment compiler et contribuer au projet.

## 🏗️ Build Guide / Guide de Compilation

Foxxite uses specific flags (`-march=native`, `-O3`, LTO, PGO) to ensure maximum performance.

### Desktop (Windows / Linux)
1. Bootstrap the environment: `./mach bootstrap`
2. Build the browser: `./mach build`
3. Package the installer: `./mach package`

### Mobile (Android)
Foxxite Android supports universal architectures (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`). No features are disabled.
1. Build GeckoView: `./mach build`
2. Assemble the APK: `./gradlew assembleRelease`

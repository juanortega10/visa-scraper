# Conectarse al RPi por SSH

Esta guía explica como conectarte al Raspberry Pi (`agetrox@rpi`) desde la Mac.
El RPi corre el worker `visa-trigger` y la sesión de Claude Code 24/7.

## Datos de conexión

| Dato | Valor |
|------|-------|
| Usuario | `agetrox` |
| Ruta del proyecto | `/home/agetrox/visa-scraper` |
| Llave SSH | `~/.ssh/id_ed25519_emmy` |
| Host remoto (túnel) | `ssh.homiapp.xyz` vía Cloudflare |
| Host local (LAN) | `192.168.50.121` |

Los valores viven en `.env` (`RPI_HOST`, `RPI_USER`, `RPI_PASS`, `RPI_PATH`) y en
`~/.ssh/config` (hosts `rpi` y `rpi-local`).

## Ruta 1: túnel Cloudflare (desde cualquier red)

El host `rpi` usa `cloudflared` como `ProxyCommand`. Funciona fuera de casa.

```bash
ssh rpi
```

Prueba rápida sin sesión interactiva:

```bash
ssh -o ConnectTimeout=25 rpi 'hostname; whoami; uname -m; uptime'
```

Requisitos en la Mac:
- `cloudflared` instalado (`/opt/homebrew/bin/cloudflared`).
- La llave `~/.ssh/id_ed25519_emmy` con permisos `600`.

## Ruta 2: red local (misma WiFi que el RPi)

Solo funciona cuando la Mac está en la red `192.168.50.x`.

```bash
ssh rpi-local
```

## Comandos útiles

Ver los logs del worker:

```bash
source .env && sshpass -p "$RPI_PASS" ssh rpi \
  "journalctl -u visa-trigger --since '5 min ago' --no-pager | tail -30"
```

Copiar archivos al RPi:

```bash
scp archivo.ts rpi:/home/agetrox/visa-scraper/scripts/
```

## Diagnóstico de fallas

### Error `websocket: bad handshake` o `error code: 1033`

Esto significa que el túnel del RPi NO está conectado a Cloudflare.
La causa está en el RPi, no en la Mac. El servicio `cloudflared` del RPi
está detenido, o el RPi está apagado o sin internet.

Verifica el estado del túnel:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 15 https://ssh.homiapp.xyz
# 530 + "error code: 1033" = túnel caído
```

Solución: reinicia el RPi o el servicio `cloudflared` en el RPi.
Si no tienes acceso físico ni LAN, debes esperar a que el RPi vuelva.

### `Operation timed out` en `rpi-local`

La Mac no está en la red local del RPi. Usa la Ruta 1 (túnel).

### `Permission denied (publickey)`

La llave falta o tiene permisos malos. Corrige:

```bash
chmod 600 ~/.ssh/id_ed25519_emmy
```

## Estado de validación (2026-08-22)

- `cloudflared`: instalado. OK.
- Llave `~/.ssh/id_ed25519_emmy`: existe, permisos `600`. OK.
- `~/.ssh/config`: hosts `rpi` y `rpi-local` presentes. OK.
- Ruta 1 (túnel): **FALLA**. `https://ssh.homiapp.xyz` devuelve `530` con
  `error code: 1033`. El túnel del RPi está caído.
- Ruta 2 (LAN): **FALLA**. Timeout. La Mac no está en la red `192.168.50.x`.

Conclusión: la configuración de la Mac es correcta. El RPi no responde por
ninguna ruta. Debes recuperar el RPi (encenderlo o reiniciar `cloudflared`)
antes de conectarte.

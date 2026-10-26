# WhatsApp MCP: instalación y uso

Herramienta propia y autoalojable para conectar varios números de WhatsApp con
agentes por MCP. Cada persona descarga el repositorio, lo compila en su servidor,
vincula sus teléfonos por QR y conecta sus agentes. No necesita Evolution ni
una clave de un proveedor de IA.

## Instalación rápida

Con Git, Docker y Docker Compose:

```sh
git clone https://github.com/kaizentrick/whatsapp-mcp.git
cd whatsapp-mcp
docker compose up -d --build
docker compose exec whatsapp-mcp cat /data/admin.token
```

Abre `http://127.0.0.1:8787`, introduce la clave privada de propietario, crea una
cuenta y pulsa **Pair with QR**. En el teléfono: **WhatsApp → Dispositivos
vinculados → Vincular un dispositivo**. Repite para cada número.

Si está en otro servidor, puedes abrir un túnel SSH:

```sh
ssh -N -L 8787:127.0.0.1:8787 usuario@servidor
```

Para agentes remotos configura tu dominio HTTPS, `WA_PUBLIC_URL` y un proxy o
túnel al puerto 8787. El endpoint será `https://TU_DOMINIO/mcp`. Publica el origen
completo para que funcionen también OAuth y sus rutas de descubrimiento. Consulta
[despliegue](deployment.md) para Caddy, Cloudflare Tunnel y systemd.

## Agentes y permisos

Puedes conectar clientes MCP mediante Streamable HTTP con OAuth/Bearer o mediante
el puente stdio incluido. La compatibilidad depende del soporte MCP del cliente,
no de la compañía que ofrece su modelo.

Genera una clave distinta por agente, limitada a una cuenta:

```sh
docker compose exec whatsapp-mcp node dist/cli.js token:create \
  --account Ventas --permissions read,send --days 30 --out /data/ventas.token
docker compose cp whatsapp-mcp:/data/ventas.token ./ventas.token
chmod 600 ventas.token
```

`read` permite consultar; `send`, enviar; `manage`, vincular, pausar o cerrar
sesiones. Una clave de cuenta no puede usar las demás. La clave de propietario
puede verlas todas. [Ejemplos de conexión](clients.md).

Hay 20 herramientas para cuentas, QR, contactos, chats, mensajes, recibos,
grupos y archivos. Todas las operaciones sobre WhatsApp seleccionan una cuenta
explícita. Puedes enviarte mensajes y escribir a un número ausente de contactos
si ese número tiene WhatsApp. No se puede enviar a un número que no tenga cuenta.

Cada envío usa un `requestId` único. Si hay un corte o un resultado incierto,
consulta su estado antes de actuar. Un envío aceptado no demuestra entrega ni
lectura. El historial disponible depende de lo sincronizado al dispositivo
vinculado; no se promete recuperar todo lo que existe en el teléfono.

## Estado y migración

La versión inicial incluye código, build, Docker, documentación y pruebas
automatizadas. Estas usan un transporte simulado. El comando opcional
`node scripts/smoke-qr.mjs` comprueba que llega un QR real, sin vincular un
teléfono ni mandar mensajes. La aceptación con teléfonos reales se hace siguiendo
[esta guía](acceptance.md).

El [roadmap](ROADMAP.md) separa el desarrollo de la migración. Conserva Evolution
hasta verificar recepción y envío en el servicio nuevo, reinicio de sesiones y
conexión de tus agentes. No copies sus claves activas a dos procesos. La
importación de su historial requiere un adaptador específico posterior.

Guarda el volumen y sus claves en privado. Las credenciales y registros originales
están cifrados, pero el texto consultable y los índices de contactos/chats no:
protege el disco y sus copias. No borres el volumen para actualizar.

Usa Baileys, un transporte no oficial de WhatsApp Web, sujeto a cambios externos.
El proyecto se distribuye bajo GPL-3.0-only; revisa `LICENSE` y `NOTICE`.

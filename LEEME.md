# Cómo publicar tu app e instalarla en celular/PC

## 1) Crear el backend en Supabase (una sola vez, para todo el equipo)

Supabase reemplaza a Google Sheets: es una base de datos real, gratis en su
plan inicial, con login integrado. **Un solo proyecto sirve para todo el
equipo** — cada persona después inicia sesión con su propio email y
contraseña, y automáticamente ve solo sus propios datos.

1. Entrá a https://supabase.com → **"Start your project"** → creá una
   cuenta (podés usar tu cuenta de Google) → **"New project"**.
2. Elegí un nombre (ej. `productividad-equipo`), una contraseña para la
   base (guardala, no hace falta usarla en la app) y una región cercana
   (ej. `South America (São Paulo)`) → **"Create new project"**. Tarda
   1-2 minutos en aprovisionarse.
3. Una vez creado, andá a **SQL Editor** (menú izquierdo) → **"New
   query"** → pegá todo el contenido del archivo **`schema.sql`**
   (incluido en esta carpeta) → **"Run"**. Esto crea las tablas y la
   seguridad que separa los datos de cada persona.
4. Andá a **Project Settings** (ícono de engranaje) → **API**. Vas a
   ver dos datos que necesitás:
   - **Project URL** (algo como `https://abcdefgh.supabase.co`)
   - **anon public key** (una clave larga que empieza con `eyJ...`)
5. Abrí `index.js` en esta carpeta y reemplazá estas dos líneas cerca
   del principio:
   ```js
   const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
   const SUPABASE_ANON_KEY = 'TU-ANON-KEY';
   ```
   con tus valores reales del paso 4.

   **Aclaración:** estos dos valores son públicos a propósito (están
   pensados para ir en el código del navegador). Lo que realmente
   protege los datos de cada usuario es la seguridad (RLS) que quedó
   configurada por `schema.sql`, no ocultar esta URL/clave.

6. Por defecto Supabase pide confirmar el email al registrarse. Para
   uso interno del equipo, si preferís que cada persona pueda entrar
   sin tener que confirmar el mail, andá a **Authentication → Providers
   → Email** y desactivá **"Confirm email"**. Si lo dejás activado,
   cada persona va a recibir un mail de confirmación la primera vez
   que se registre (recomendado si les importa la seguridad del acceso).

## 2) Subir los archivos a GitHub Pages (gratis)

1. Entrá a https://github.com y creá una cuenta si no tenés (gratis).
2. Creá un repositorio nuevo:
   - Botón verde **"New"** → nombre, por ejemplo `productividad` → **Public** → **Create repository**.
3. Subí estos archivos y carpetas tal cual están (mismo nombre, misma ubicación) — **con el `index.js` ya editado del paso 1**:
   ```
   index.html
   style.css
   index.js
   manifest.json
   service-worker.js
   icons/   (toda la carpeta con los .png y el favicon.ico)
   ```
   - No hace falta subir `schema.sql`, es solo para pegarlo una vez en Supabase.
   - En GitHub, click en **"Add file" → "Upload files"**, arrastrá todo (incluida la carpeta `icons`) y confirmá con **Commit changes**.
4. Andá a **Settings → Pages** (menú izquierdo).
5. En **"Build and deployment" → Source**, elegí **"Deploy from a branch"**, branch **`main`**, carpeta **`/ (root)`** → **Save**.
6. Esperá 1-2 minutos. GitHub te va a dar una URL como:
   ```
   https://tu-usuario.github.io/productividad/
   ```
   Esa es la URL de tu app, accesible desde cualquier dispositivo con internet.

## 3) Instalar en el celular (Android)

1. Abrí esa URL en **Chrome**.
2. Va a aparecer un cartel "Agregar a pantalla de inicio" o tocá el menú (⋮) → **"Instalar app"**.
3. Confirmá. Te va a quedar el ícono en el home, y abre en pantalla completa como una app nativa.

## 4) Instalar en iPhone (Safari)

1. Abrí la URL en **Safari** (tiene que ser Safari, no Chrome, por una limitación de iOS).
2. Tocá el ícono de **Compartir** (el cuadrado con flecha hacia arriba).
3. Elegí **"Agregar a pantalla de inicio"**.
4. Confirmá. Queda el ícono, y abre sin la barra de Safari.

## 5) Instalar en PC (Windows / Mac / Linux)

1. Abrí la URL en **Chrome** o **Edge**.
2. En la barra de direcciones, a la derecha, aparece un ícono de **"Instalar"** (una pantallita con una flecha). Si no lo ves, menú (⋮) → **"Instalar Productividad..."**.
3. Confirmá. Te queda como una app de escritorio con su propio ícono, ventana propia y acceso directo, sin pestañas del navegador.

## 6) Cómo se registra cada compañero (una sola vez, 1 minuto)

Ya no hace falta que cada persona configure nada técnico. Con el mismo
link de la app:

1. Abren la app → aparece la pantalla de login.
2. Tocan **"¿No tenés cuenta? Registrate"**, ponen su email y una
   contraseña (mínimo 6 caracteres) → **"Crear cuenta"**.
3. Si dejaste activada la confirmación por email (ver paso 1.6), revisan
   su correo y tocan el link de confirmación, y después inician sesión
   normalmente.
4. Listo — a partir de ahí ven únicamente sus propias tareas,
   eventualidades, recordatorios e historial. Nadie más tiene acceso a
   sus datos, ni siquiera vos.

Cada persona queda logueada en su dispositivo (no hay que volver a
loguearse cada vez que abre la app), pero si instalan la app en el
celular Y en la PC, inician sesión una vez en cada dispositivo con el
mismo email/contraseña.

## 7) Cómo actualizar la app cuando cambies algo

Cada vez que edites `index.html`, `style.css` o `index.js`:

1. Subí los archivos nuevos al mismo repositorio de GitHub (reemplazando los viejos).
2. Abrí `service-worker.js` y subí el número de versión, por ejemplo:
   ```js
   const CACHE_VERSION = 'v3';
   ```
   Esto asegura que todos los dispositivos bajen la versión nueva en vez de quedarse con la vieja en caché.
3. Los dispositivos van a actualizarse solos la próxima vez que abran la app (puede tardar unos segundos en notarse; si querés verlo al toque, cerrá y volvé a abrir la app, o recargá con Ctrl+Shift+R / Cmd+Shift+R).

## Sobre la sincronización entre dispositivos

- **Tiempo real de verdad:** Supabase Realtime empuja los cambios a todos
  los demás dispositivos de la misma cuenta apenas ocurren (iniciar,
  pausar o terminar una tarea aparece casi al instante en el otro
  dispositivo, sin esperar ningún intervalo).
- Además hay un chequeo de respaldo cada 60 segundos (por si algún
  dispositivo perdió la conexión en tiempo real, por ejemplo al
  despertar del modo suspendido).
- Cualquier cambio que hagas se guarda localmente al instante y se sube
  a Supabase ~1.2s después.
- **Importante:** si tenés un timer corriendo en un dispositivo, ese
  dispositivo no va a auto-sincronizar hasta que pares el timer (para
  no cortarte la sesión a mitad de camino). Podés forzar la
  sincronización en cualquier momento con el botón **"⟲ Sincronizar"**.

## Funciona offline

Gracias al service worker, la app abre instantáneamente aunque no tengas
internet (usa la última versión guardada en caché + tu caché local del
navegador). Los cambios que hagas offline se guardan localmente y se
suben a Supabase automáticamente en cuanto vuelva la conexión. La
sesión de login también se mantiene offline.

## Privacidad y seguridad, en criollo

- Cada persona tiene su propia cuenta (email + contraseña) manejada por
  Supabase Auth (el mismo sistema que usan miles de apps).
- La base de datos tiene activada la **Row Level Security**: a nivel de
  base de datos (no solo en el código de la app) está garantizado que
  cada consulta solo puede leer o escribir filas donde `user_id` sea el
  de la persona logueada. Ni siquiera compartiendo la URL de la app se
  puede acceder a los datos de otra persona.
- Como dueño del proyecto de Supabase, vos sí podés ver todos los datos
  de todos entrando al panel de Supabase directamente (es tu base de
  datos) — pero desde la app, cada uno ve solo lo suyo.

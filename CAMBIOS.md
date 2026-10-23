# Cambios: sincronización, timer móvil, responsive y tablero Kanban

## Paso obligatorio en Supabase (una sola vez)
Abrí Supabase → **SQL Editor** → New query, pegá `supabase/migracion_kanban.sql` y dale **Run**.
Agrega las columnas `status` y `sortOrder` (columna y orden en el tablero) y revisa permisos y Realtime.
Si no la corrés, la app funciona igual, pero la columna de cada tarjeta se guarda solo en el dispositivo donde la moviste.

## 1. Sincronización (tareas que desaparecían o se duplicaban)
**Causa:** cada cambio subía *todo* el estado y la base borraba y volvía a insertar todas las filas (`save_full_state`).
- Un dispositivo con datos viejos (por ejemplo el celular que volvía de segundo plano) pisaba lo que había hecho el otro. Las tareas desaparecían o reaparecían.
- Cada guardado generaba cientos de eventos DELETE+INSERT en Realtime. El otro dispositivo hacía un pull a mitad de camino y mostraba una lista incompleta hasta recargar.
- Al iniciar sesión se hacía un pull forzado que pisaba cambios locales todavía sin subir.

**Ahora la sincronización va por registro:**
- Se guarda un "snapshot" de lo último confirmado por el servidor. Solo se suben las filas que cambiaron (upsert) y las que se borraron (delete por id).
- Al bajar se combinan los datos registro por registro: si algo tiene cambios locales sin subir, gana el local. Si no, gana el servidor. Si se borró en otro dispositivo, se respeta el borrado.
- Realtime aplica cada fila apenas llega, sin pull completo. Al volver a la pestaña, al recuperar la red y cada 60 segundos se hace un pull de respaldo.
- Si un push falla, se reintenta con espera creciente. El indicador muestra "Cambios por subir…".
- Hay un botón nuevo en **Datos → 🧹 Buscar y eliminar tareas duplicadas** para limpiar las que hayan quedado de antes.

## 2. Timer en el móvil
- **Causa:** el contador solo empezaba a correr si se tocaba ▶ en *ese* dispositivo. Si el timer llegaba desde la PC, quedaba congelado.
- Ahora cada render verifica si hay un timer activo y arranca el contador. La pestaña muestra el tiempo en el título.
- **Fechas:** `today()` usaba UTC, así que desde las 21 hs (hora de Argentina) "hoy" ya era mañana. Ahora usa la fecha local.
- **Filtro de tareas:** la vista por defecto ocultaba las tareas vencidas. Ahora muestra las pendientes (incluidas las vencidas) y las completadas hoy.

## 3. Dashboard y tablero Kanban
- Saludo, métricas del día, tarjeta de foco con el timer grande y una sugerencia de la próxima tarea cuando no hay nada en curso.
- Tablero con columnas **Por hacer / En curso / En espera / Hecho**:
  - En PC se arrastra con el mouse. En el celular se mantiene apretada la tarjeta y se arrastra, o se usa el menú ⋯.
  - Soltar en **Hecho** completa la tarea y genera la próxima recurrencia. Soltar en **En espera** pausa el timer. Volver a **Por hacer** lo detiene y guarda la sesión.
  - Filtros por período (Hoy / Semana / Todo), por tipo (Tareas / Eventualidades) y buscador.

## 4. Responsive
- En celular: barra de navegación inferior, botón flotante **+** (tarea, eventualidad, recordatorio) y menú **Más**.
- Los modales se abren como hoja inferior y los botones son más grandes.
- El tablero se desliza por columnas y el calendario y Analytics están compactados.
- En tablet: barra lateral de íconos y tablero en 2 columnas.

## Otros
- Se escapa el texto del usuario antes de mostrarlo, así un nombre con `<` ya no rompe la página.
- El sonido del pomodoro usa una ruta relativa: antes no sonaba en GitHub Pages.
- El service worker ahora pide primero la red para HTML/JS/CSS, así cada dispositivo recibe la versión nueva sin recargar dos veces.
- `supabase/schema.sql` se restauró desde el historial de git, ya con las columnas nuevas.

---

# Proyectos

## Paso obligatorio en Supabase (una sola vez)
Abrí SQL Editor, pegá `supabase/migracion_proyectos.sql` y dale Run. Crea la tabla `projects` y agrega la columna `projectId` a tareas y eventualidades.
Sin esta migración la app funciona igual, pero los proyectos se guardan solo en el dispositivo donde los creás.

## Qué incluye
- **Vista Proyectos** (barra lateral y menú "Más" en el celular): tarjetas con color, progreso, tiempo invertido, tareas vencidas y fecha objetivo. Se pueden archivar.
- **Detalle de un proyecto**: sus tareas y eventualidades, "+ Tarea" con el proyecto ya elegido, editar, archivar y eliminar.
- **Al eliminar un proyecto** sus tareas no se borran: quedan "sin proyecto".
- **Elegir proyecto al crear** una tarea o eventualidad.
- **Asignar una tarea existente** desde el menú ⋯ de su tarjeta en el tablero.
- **Filtro por proyecto** en el tablero y en la vista Tareas. Las tarjetas muestran un chip con el proyecto, y al tocarlo se abre.
- **Recurrencias**: la próxima instancia de una tarea hereda su proyecto.

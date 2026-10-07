# Real-time Chat — Dirección de producto

Fecha: 2026-10-06. Refinamiento del alcance ya aceptado; implementación pendiente.

## Problema

¿Cómo podemos permitir que un evaluador compruebe en pocos minutos el criterio de un senior fullstack mediante una conversación que se mantiene consistente cuando falla la red?

El usuario funcional es un miembro de un equipo pequeño. El público del portfolio son responsables técnicos y entrevistadores; el resultado buscado es una demo comprensible, código mantenible y decisiones defendibles. No se ha validado demanda comercial ni se pretende sustituir Slack.

## Variantes exploradas

| Variante | Motivo para considerarla | Decisión |
|---|---|---|
| Una única sala persistente | Reduce el tiempo hasta la primera conversación | Hito intermedio; por sí sola muestra pocos permisos de dominio |
| Chat de equipo por canales | Equilibra producto, autorización y estado en tiempo real | Base elegida |
| Chat centrado en recuperación de fallos | Permite demostrar consistencia con un caso visible y reproducible | Diferenciador elegido dentro de la base |
| Bandeja de soporte cliente-agente | Ofrece un caso de negocio concreto | Posponer: requiere asignación, roles y estados de atención |
| Chat local-first con cola duradera | Hace interesante la experiencia sin red | Posponer: IndexedDB y reconciliación amplían demasiado la v1 |
| Chat distribuido con varias instancias | Permite estudiar coordinación y capacidad | Posponer: exige infraestructura y pruebas que no aportan valor a la primera demo |

Estas variantes se agrupan en tres direcciones: **chat de equipo fiable**, **producto de soporte** y **sistema distribuido/offline avanzado**. La primera ofrece el mejor equilibrio de valor para el portfolio, viabilidad y diferenciación observable. La dificultad principal será la sincronización; las otras direcciones añadirían problemas distintos sin mejorar la demostración inicial.

## Dirección recomendada

Mantener un espacio de equipo con canales y mensajes de texto. Cuidar tanto la interfaz como el comportamiento ante respuestas perdidas, desconexiones y sesiones revocadas. El recorrido de demostración será entrar con dos sesiones, conversar, interrumpir la red y recuperar la conversación sin duplicados.

El éxito será verificable: primer mensaje en menos de dos minutos una vez arrancada la demo local en Docker como objetivo de usabilidad, recuperación correcta comprobada por E2E y documentación que permita arrancar el proyecto desde cero. Los límites de latencia y capacidad se publicarán solo después de medirlos.

## Supuestos que deben validarse

| Supuesto | Importancia | Validación / alternativa |
|---|---|---|
| El evaluador puede ejecutar la demo local con poca fricción | Crítica para presentar el portfolio | Clonar GitHub, arrancar Compose sin Node/BD en host y aportar un vídeo |
| Un único proceso backend es suficiente para la demo | Importante | Prueba funcional con varias sesiones; medir antes de añadir Redis |
| La sincronización propuesta resiste eventos perdidos y commits concurrentes | Crítica para la promesa técnica | Pruebas de integración tempranas; no publicar la garantía si fallan |
| Docker y el proxy local mantienen conexiones persistentes | Crítica para la demo en tiempo real | Smoke test temprano de login y Socket.IO en localhost; no desplegar remotamente |
| La calidad y el alcance tienen prioridad sobre la fecha inicial | Confirmado por el usuario | Planificar esfuerzo por tarea y recalibrar tras las primeras etapas |
| Presencia y escritura aportan suficiente valor | Secundaria | Incorporar después de la v1; no bloquean la entrega local |

## MVP y exclusiones

V1: identidad, canales, membresía, historial, envío persistente, reintento idempotente, recuperación y UI accesible. GitHub desde la primera tarea, CI, pruebas críticas, documentación y demo local completa en Docker Compose forman parte de la entrega. El despliegue remoto queda fuera del alcance actual.

No hacer en v1: mensajes privados y roles complejos (otro modelo de permisos), adjuntos y vídeo (otro flujo de almacenamiento/transporte), edición/borrado (sincronización de mutaciones antiguas), offline duradero (otro modelo de estado), multiinstancia (coordinación distribuida) ni dashboards de operación (logs y health checks bastan inicialmente).

## Riesgos de fracaso y respuesta

- Una demo técnicamente sólida pero difícil de probar: seed y recorrido de dos usuarios desde el inicio de la fase de presentación.
- Un repositorio grande sin comportamiento fiable: priorizar las pruebas de concurrencia y recuperación antes de extras visuales.
- Una promesa de plazo demasiado agresiva: estimar en horas, registrar tiempo real y reservar contingencia.
- Auth o canales consumen todo el presupuesto: mantener un solo espacio, sesiones simples y ninguna gestión de roles.

## Decisiones pendientes

Solo queda por concretar la dedicación diaria y, al iniciar GitHub, propietario/visibilidad del repositorio. El usuario confirmó que prefiere completar el alcance aunque lleve más tiempo y que la aplicación solo correrá localmente, containerizada para facilitar un despliegue futuro. No se necesita proveedor, dominio ni presupuesto de hosting en esta entrega. El plan ejecutable y las casillas de progreso viven únicamente en [tasks/plan.md](../../tasks/plan.md).

---
description: Review de pull request con foco en calidad, bugs y estilo
---
Actúa como un senior engineer haciendo code review de un Pull Request.

$ARGS

Si no se pasa argumento, usa el diff actual del repositorio (staged + unstaged).

Evalúa en este orden:

## 🐛 Bugs y errores potenciales
Lista cualquier comportamiento incorrecto, race condition, null pointer, o lógica errónea.
Para cada uno: descripción del problema, línea afectada, fix concreto.

## 🔒 Seguridad
¿Hay algún vector de ataque, exposición de datos o validación faltante?

## ⚡ Rendimiento
¿Hay queries N+1, renders innecesarios, o algoritmos subóptimos?

## 🏗️ Arquitectura y diseño
¿El cambio encaja bien con el resto de la codebase?
¿Hay responsabilidades mal asignadas o acoplamiento excesivo?

## 📝 Estilo y convenciones
¿Sigue los patrones del proyecto?
¿Los nombres son claros?

## ✅ Veredicto
- **Aprobado**: el cambio está listo para merge
- **Cambios menores**: aprobado con pequeños fixes sugeridos
- **Cambios importantes**: necesita revisión antes de merge
- **Rechazado**: hay problemas fundamentales

Resume en 2-3 frases qué hace bien este PR y qué necesita mejorar.

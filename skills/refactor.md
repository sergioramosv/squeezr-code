---
description: Refactorizar código mejorando legibilidad, mantenibilidad y rendimiento
---
Refactoriza el siguiente código manteniendo el comportamiento exacto: $ARGS

Aplica estas mejoras donde corresponda:

## Legibilidad
- Nombres descriptivos para variables, funciones y clases
- Funciones pequeñas con una sola responsabilidad (SRP)
- Eliminar código muerto, comentarios obsoletos y duplicaciones
- Simplificar condicionales complejos (early return, guard clauses)

## Mantenibilidad
- Separar concerns (lógica de negocio vs UI vs acceso a datos)
- Extraer constantes con nombres descriptivos
- Reducir acoplamiento entre módulos
- Añadir tipos TypeScript donde falten

## Rendimiento (solo si hay ganancia clara)
- Evitar re-renders o recálculos innecesarios
- Usar estructuras de datos apropiadas
- Memoización donde tenga sentido

## Output esperado:
1. El código refactorizado completo
2. Una lista de los cambios realizados y por qué
3. Si hay cambios de comportamiento involuntarios, marcalos claramente con ⚠️

---
description: Generar tests unitarios e integración para el código dado
---
Genera tests completos para el siguiente código: $ARGS

Sigue estas reglas:
- Usa el framework de testing ya presente en el proyecto (detecta por package.json)
- Si no hay framework, usa vitest (TypeScript) o jest (JavaScript)
- Cubre: happy path, edge cases, error cases, límites de entrada
- Los tests deben ser independientes (no depender unos de otros)
- Usa mocks para dependencias externas (HTTP, filesystem, DB)
- Nombres descriptivos: `describe('nombreFunción', () => { it('debe hacer X cuando Y', ...) })`

Para cada función/método testea:
1. **Comportamiento normal**: inputs válidos → output esperado
2. **Casos límite**: valores vacíos, null, undefined, arrays vacíos, strings vacíos
3. **Casos de error**: inputs inválidos, excepciones esperadas
4. **Efectos secundarios**: llamadas a mocks, estado modificado

Estructura el output como:
- Primero los imports y setup
- Luego un describe block por función/clase
- Comenta brevemente qué prueba cada test si no es obvio

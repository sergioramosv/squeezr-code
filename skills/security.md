---
description: Auditoría de seguridad de código (OWASP, inyección, auth, secrets)
---
Actúa como un auditor de seguridad senior. Realiza una revisión de seguridad exhaustiva del siguiente código: $ARGS

Busca específicamente:

## Vulnerabilidades OWASP Top 10
- Inyección (SQL, NoSQL, comando, LDAP)
- Broken Authentication / Session Management
- Exposición de datos sensibles
- XXE (XML External Entities)
- Broken Access Control
- Security Misconfiguration
- XSS (Cross-Site Scripting)
- Deserialización insegura
- Componentes con vulnerabilidades conocidas
- Logging y monitorización insuficientes

## Secrets y credenciales
- API keys, tokens, passwords hardcodeados
- Variables de entorno no validadas
- Secretos en logs o respuestas de error

## Validación de input
- ¿Se valida y sanitiza toda la entrada del usuario?
- ¿Se usan queries parametrizadas?
- ¿Hay validación en cliente y servidor?

## Control de acceso
- ¿Se verifica autorización en cada endpoint?
- ¿Hay escalada de privilegios posible?
- ¿Los recursos están protegidos correctamente?

## Para cada vulnerabilidad encontrada reporta:
- **Severidad**: Crítica / Alta / Media / Baja
- **Descripción**: qué es el problema
- **Impacto**: qué puede hacer un atacante
- **Línea/función afectada**
- **Fix concreto**: código corregido

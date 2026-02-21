# PLAN-ai-self-learning

## 🧠 Brainstorm: AI Self-Learning & Tone Imitation System

### Context
El objetivo es que el agente de IA aprenda automáticamente del usuario: cómo responde a ciertos correos, su tono, su vocabulario y sus decisiones. Con esta data, la IA debe reescribir sus instrucciones (prompt) para volverse más autónoma y generar borradores que requieran cero edición.

---

### Opción A: "El Observador Nocturno" (Evolución de Prompt Automatizada)
Un script o proceso en background evalúa diariamente la diferencia entre lo que la IA sugirió y lo que el usuario *finalmente envió*. Un agente "Crítico" analiza esa brecha y reescribe el campo `aiInstructions` en SQLite guardando las nuevas reglas de tono y decisión (ej. "El usuario nunca usa despedidas formales").

✅ **Pros:**
- Verdadero aprendizaje autónomo. El prompt evoluciona literalmente.
- Bajo consumo de tokens en las operaciones del día a día.
- Mantiene la lógica del lado del cliente/Tauri rápida.

❌ **Cons:**
- Requiere control de versiones del prompt (para poder revertir si la IA aprende "malos hábitos").
- Configurar el job en background con Tauri puede ser complejo.

📊 **Esfuerzo:** Alto

---

### Opción B: RAG Continuo (Recuperación con Ejemplos "Few-Shot")
En la base de datos local SQLite, guardamos todos tus correos enviados junto con su vector contextual. Cada vez que la IA redacte un borrador, busca los 3 correos tuyos que más se parezcan al contexto actual y los inyecta en el prompt oculto como ejemplos de tu estilo.

✅ **Pros:**
- Imitación de tono extremadamente fiel y basada en casos reales.
- No hay riesgo de que el "prompt" general se corrompa, el aprendizaje es al vuelo.

❌ **Cons:**
- Mayor consumo de tokens en cada llamado (se envían siempre 3 ejemplos largos).
- Implica añadir una base de datos vectorial o búsqueda por similitud (FTS5 en SQLite).

📊 **Esfuerzo:** Medio

---

### Opción C: Actualización Asistida por el Usuario (Human-in-the-Loop)
Añadimos un botón en la interfaz que diga "Analizar mi bandeja de Salida". Al presionarlo, la IA lee los últimos 50 correos enviados, extrae guías de estilo y te presenta una propuesta de actualización para tus `aiInstructions`. Tú la apruebas o editas antes de guardarla en la BD.

✅ **Pros:**
- Tienes control total sobre lo que la IA "aprende" o cree de ti.
- Muy fácil y rápido de implementar usando el esquema SQLite actual.

❌ **Cons:**
- Requiere acción manual, limitando la "autonomía pura" que solicitas.

📊 **Esfuerzo:** Bajo

---

## 💡 Recomendación del Orchestrator
**Opción A (El Observador Nocturno)** combinada con toques de la **Opción C**.
Podemos crear un proceso dentro de Rust (o llamado desde el frontend al primer arranque del día) que analice tus correos enviados recientes frente a los borradores generados. Este proceso generará una "propuesta de actualización de Prompt", te la mostrará sutilmente como una notificación y, si no la rechazas, actualizará la directiva de la IA automáticamente. 

---

## 🛑 Socratic Gate (Preguntas de Clarificación)

Antes de empezar a codear, como Arquitectos de Backend y DevOps, necesitamos definir:

1. **Escala y Costo:** ¿Estás dispuesto a usar un poco más de tokens una vez al día para que otro Agente IA actúe como "entrenador/evaluador" de tu Agente principal?
2. **Ciclo de Aprendizaje:** ¿Prefieres que el prompt se actualice *solo y en background*, o prefieres ver un pequeño "Reporte de Aprendizaje" semanal donde apruebas lo que aprendió?
3. **Control de Errores:** Si la IA empieza a sonar muy coloquial o aprende un tono equivocado de un par de correos, ¿quieres un botón de "Rollback" para regresar al nivel de aprendizaje de la semana anterior?

---
*Fin del Plan. A la espera de la confirmación del usuario para proceder a la Fase de Implementación.*

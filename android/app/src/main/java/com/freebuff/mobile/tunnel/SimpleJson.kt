package com.freebuff.mobile.tunnel

/**
 * Minimal JSON parser + serializer used by the tunnel prototype. Pure JVM with
 * no Android/org.json dependency so the whole tunnel stack is unit-testable on
 * the host. The tunnel wire format is mostly flat (`h:`-prefixed header keys),
 * but nested objects/arrays/numbers/booleans/null are supported too.
 */
object SimpleJson {
    fun parse(text: String): Any? {
        val parser = Parser(text)
        parser.skipWhitespace()
        val value = parser.parseValue()
        parser.skipWhitespace()
        if (!parser.atEnd()) throw IllegalArgumentException("Trailing JSON content at ${parser.pos}")
        return value
    }

    fun parseObject(text: String): Map<String, Any?> {
        val value = parse(text)
        if (value !is Map<*, *>) throw IllegalArgumentException("Expected JSON object")
        @Suppress("UNCHECKED_CAST")
        return value as Map<String, Any?>
    }

    fun stringify(value: Any?): String {
        val sb = StringBuilder()
        write(value, sb)
        return sb.toString()
    }

    fun string(value: Any?, fallback: String = ""): String = when (value) {
        null -> fallback
        is String -> value
        else -> value.toString()
    }

    private fun write(value: Any?, sb: StringBuilder) {
        when (value) {
            null -> sb.append("null")
            is String -> {
                sb.append('"')
                for (c in value) {
                    when (c) {
                        '"' -> sb.append("\\\"")
                        '\\' -> sb.append("\\\\")
                        '\n' -> sb.append("\\n")
                        '\r' -> sb.append("\\r")
                        '\t' -> sb.append("\\t")
                        '\b' -> sb.append("\\b")
                        '\u000C' -> sb.append("\\f")
                        else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
                    }
                }
                sb.append('"')
            }
            is Boolean -> sb.append(value.toString())
            is Number -> sb.append(value.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    write(k.toString(), sb)
                    sb.append(':')
                    write(v, sb)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (v in value) {
                    if (!first) sb.append(',')
                    first = false
                    write(v, sb)
                }
                sb.append(']')
            }
            else -> write(value.toString(), sb)
        }
    }

    private class Parser(private val text: String) {
        var pos = 0
            private set

        fun atEnd(): Boolean = pos >= text.length

        fun skipWhitespace() {
            while (pos < text.length && text[pos].isWhitespace()) pos++
        }

        fun parseValue(): Any? {
            skipWhitespace()
            if (atEnd()) throw IllegalArgumentException("Unexpected end of JSON")
            return when (text[pos]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> parseString()
                't' -> { expect("true"); true }
                'f' -> { expect("false"); false }
                'n' -> { expect("null"); null }
                else -> parseNumber()
            }
        }

        private fun parseObject(): Map<String, Any?> {
            expect("{")
            skipWhitespace()
            val result = LinkedHashMap<String, Any?>()
            if (peek() == '}') { pos++; return result }
            while (true) {
                skipWhitespace()
                val key = parseString()
                skipWhitespace()
                expect(":")
                val value = parseValue()
                result[key] = value
                skipWhitespace()
                when (peek()) {
                    ',' -> pos++
                    '}' -> { pos++; return result }
                    else -> throw IllegalArgumentException("Expected ',' or '}' at $pos")
                }
            }
        }

        private fun parseArray(): List<Any?> {
            expect("[")
            skipWhitespace()
            val result = ArrayList<Any?>()
            if (peek() == ']') { pos++; return result }
            while (true) {
                result.add(parseValue())
                skipWhitespace()
                when (peek()) {
                    ',' -> pos++
                    ']' -> { pos++; return result }
                    else -> throw IllegalArgumentException("Expected ',' or ']' at $pos")
                }
            }
        }

        private fun parseString(): String {
            expect("\"")
            val sb = StringBuilder()
            while (pos < text.length) {
                val c = text[pos++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (pos >= text.length) throw IllegalArgumentException("Bad escape")
                        val esc = text[pos++]
                        when (esc) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > text.length) throw IllegalArgumentException("Bad unicode escape")
                                val hex = text.substring(pos, pos + 4)
                                sb.append(hex.toInt(16).toChar())
                                pos += 4
                            }
                            else -> throw IllegalArgumentException("Bad escape \\$esc")
                        }
                    }
                    c.code < 0x20 -> throw IllegalArgumentException("Control char in string")
                    else -> sb.append(c)
                }
            }
            throw IllegalArgumentException("Unterminated string")
        }

        private fun parseNumber(): Any? {
            val start = pos
            if (pos < text.length && text[pos] == '-') pos++
            while (pos < text.length && text[pos].isDigit()) pos++
            var isDouble = false
            if (pos < text.length && text[pos] == '.') {
                isDouble = true
                pos++
                while (pos < text.length && text[pos].isDigit()) pos++
            }
            if (pos < text.length && (text[pos] == 'e' || text[pos] == 'E')) {
                isDouble = true
                pos++
                if (pos < text.length && (text[pos] == '+' || text[pos] == '-')) pos++
                while (pos < text.length && text[pos].isDigit()) pos++
            }
            val token = text.substring(start, pos)
            if (token.isEmpty()) throw IllegalArgumentException("Expected number at $start")
            return if (isDouble) token.toDouble() else token.toLong()
        }

        private fun peek(): Char = if (atEnd()) '\u0000' else text[pos]

        private fun expect(literal: String) {
            if (!text.startsWith(literal, pos)) {
                throw IllegalArgumentException("Expected '$literal' at $pos")
            }
            pos += literal.length
        }
    }
}

package com.bookstore.ecom.logging;

import ch.qos.logback.classic.pattern.ClassicConverter;
import ch.qos.logback.classic.spi.ILoggingEvent;

import java.util.regex.Pattern;

/**
 * Logback converter that masks PII patterns in log messages.
 * Redacts UUIDs that appear in userId/user_id context.
 */
public class PIIMaskingConverter extends ClassicConverter {

    private static final Pattern USER_ID_PATTERN = Pattern.compile(
        "(userId?[=:\\s\"]+)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        Pattern.CASE_INSENSITIVE
    );

    @Override
    public String convert(ILoggingEvent event) {
        String message = event.getFormattedMessage();
        if (message == null) {
            return "";
        }
        return USER_ID_PATTERN.matcher(message).replaceAll("$1[REDACTED]");
    }
}

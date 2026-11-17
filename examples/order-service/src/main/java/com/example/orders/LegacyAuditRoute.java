package com.example.orders;

import org.apache.camel.builder.RouteBuilder;
import org.springframework.stereotype.Component;

/**
 * A route written in the Java DSL. Camel Studio lists it next to the YAML
 * routes and shows it read-only.
 */
@Component
public class LegacyAuditRoute extends RouteBuilder {

    @Override
    public void configure() {
        from("seda:audit")
            .routeId("legacy-audit")
            .log("Audit event: ${body}")
            .to("file:target/audit?fileName=audit-${date:now:yyyyMMdd}.log&fileExist=Append");
    }
}

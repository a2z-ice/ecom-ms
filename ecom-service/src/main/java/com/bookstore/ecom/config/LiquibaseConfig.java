package com.bookstore.ecom.config;

import liquibase.integration.spring.SpringLiquibase;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.DependsOn;

import javax.sql.DataSource;

@Configuration
public class LiquibaseConfig {

    /**
     * Explicit Liquibase bean required for Spring Boot 4.0 / Spring Framework 7.0
     * where auto-configuration ordering may not guarantee Liquibase runs before
     * the JPA EntityManagerFactory.
     */
    @Bean("liquibase")
    public SpringLiquibase liquibase(DataSource dataSource) {
        SpringLiquibase liquibase = new SpringLiquibase();
        liquibase.setDataSource(dataSource);
        liquibase.setChangeLog("classpath:db/changelog/db.changelog-master.yaml");
        return liquibase;
    }
}

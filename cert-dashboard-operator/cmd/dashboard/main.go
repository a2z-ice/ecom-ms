package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/bookstore/cert-dashboard-operator/internal/dashboard"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	config := dashboard.ConfigFromEnv()
	server, err := dashboard.NewServer(config)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := server.Run(ctx); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

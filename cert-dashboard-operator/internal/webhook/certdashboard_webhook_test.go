/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package webhook

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	certsv1alpha1 "github.com/bookstore/cert-dashboard-operator/api/v1alpha1"
)

func TestValidate_ValidCR(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			NodePort:            32600,
			Replicas:            1,
			Image:               "bookstore/cert-dashboard:latest",
			YellowThresholdDays: 10,
			RedThresholdDays:    5,
		},
	}
	warnings, err := v.ValidateCreate(context.Background(), cd)
	if err != nil {
		t.Errorf("expected no error, got: %v", err)
	}
	if len(warnings) > 0 {
		t.Errorf("expected no warnings, got: %v", warnings)
	}
}

func TestValidate_RedThresholdGreaterThanYellow(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:               "bookstore/cert-dashboard:latest",
			YellowThresholdDays: 5,
			RedThresholdDays:    10,
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err == nil {
		t.Error("expected error for redThresholdDays >= yellowThresholdDays, got nil")
	}
}

func TestValidate_RedThresholdEqualToYellow(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:               "bookstore/cert-dashboard:latest",
			YellowThresholdDays: 5,
			RedThresholdDays:    5,
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err == nil {
		t.Error("expected error for redThresholdDays == yellowThresholdDays, got nil")
	}
}

func TestValidate_EmptyImage(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image: "",
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err == nil {
		t.Error("expected error for empty image, got nil")
	}
}

func TestValidate_NegativeReplicas(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:    "bookstore/cert-dashboard:latest",
			Replicas: -1,
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err == nil {
		t.Error("expected error for negative replicas, got nil")
	}
}

func TestValidate_InvalidNodePort(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:    "bookstore/cert-dashboard:latest",
			NodePort: 8080,
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err == nil {
		t.Error("expected error for nodePort outside range, got nil")
	}
}

func TestValidate_Update(t *testing.T) {
	v := &CertDashboardValidator{}
	old := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:               "bookstore/cert-dashboard:v1",
			YellowThresholdDays: 10,
			RedThresholdDays:    5,
		},
	}
	new := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			Image:               "bookstore/cert-dashboard:v2",
			YellowThresholdDays: 10,
			RedThresholdDays:    5,
		},
	}
	_, err := v.ValidateUpdate(context.Background(), old, new)
	if err != nil {
		t.Errorf("expected no error, got: %v", err)
	}
}

func TestValidate_DeleteAlwaysAllowed(t *testing.T) {
	v := &CertDashboardValidator{}
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
	}
	_, err := v.ValidateDelete(context.Background(), cd)
	if err != nil {
		t.Errorf("expected no error on delete, got: %v", err)
	}
}

func TestValidate_DefaultsValid(t *testing.T) {
	v := &CertDashboardValidator{}
	// Simulates a CR with kubebuilder defaults applied
	cd := &certsv1alpha1.CertDashboard{
		ObjectMeta: metav1.ObjectMeta{Name: "test", Namespace: "default"},
		Spec: certsv1alpha1.CertDashboardSpec{
			NodePort:            32600,
			Replicas:            1,
			Image:               "bookstore/cert-dashboard:latest",
			YellowThresholdDays: 10,
			RedThresholdDays:    5,
		},
	}
	_, err := v.ValidateCreate(context.Background(), cd)
	if err != nil {
		t.Errorf("expected defaults to be valid, got: %v", err)
	}
}

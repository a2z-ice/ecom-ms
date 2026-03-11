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
	"fmt"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	certsv1alpha1 "github.com/bookstore/cert-dashboard-operator/api/v1alpha1"
)

// CertDashboardValidator validates CertDashboard resources.
type CertDashboardValidator struct{}

var _ admission.CustomValidator = &CertDashboardValidator{}

// ValidateCreate validates a new CertDashboard.
func (v *CertDashboardValidator) ValidateCreate(_ context.Context, obj runtime.Object) (admission.Warnings, error) {
	cd, ok := obj.(*certsv1alpha1.CertDashboard)
	if !ok {
		return nil, fmt.Errorf("expected CertDashboard, got %T", obj)
	}
	return v.validate(cd)
}

// ValidateUpdate validates an updated CertDashboard.
func (v *CertDashboardValidator) ValidateUpdate(_ context.Context, _, newObj runtime.Object) (admission.Warnings, error) {
	cd, ok := newObj.(*certsv1alpha1.CertDashboard)
	if !ok {
		return nil, fmt.Errorf("expected CertDashboard, got %T", newObj)
	}
	return v.validate(cd)
}

// ValidateDelete allows all deletions.
func (v *CertDashboardValidator) ValidateDelete(_ context.Context, _ runtime.Object) (admission.Warnings, error) {
	return nil, nil
}

func (v *CertDashboardValidator) validate(cd *certsv1alpha1.CertDashboard) (admission.Warnings, error) {
	var allErrs field.ErrorList
	specPath := field.NewPath("spec")

	// RedThresholdDays must be less than YellowThresholdDays
	if cd.Spec.RedThresholdDays > 0 && cd.Spec.YellowThresholdDays > 0 {
		if cd.Spec.RedThresholdDays >= cd.Spec.YellowThresholdDays {
			allErrs = append(allErrs, field.Invalid(
				specPath.Child("redThresholdDays"),
				cd.Spec.RedThresholdDays,
				"must be less than yellowThresholdDays",
			))
		}
	}

	// Image must not be empty (when explicitly set)
	if cd.Spec.Image == "" {
		allErrs = append(allErrs, field.Required(
			specPath.Child("image"),
			"container image is required",
		))
	}

	// Replicas must be positive
	if cd.Spec.Replicas < 0 {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("replicas"),
			cd.Spec.Replicas,
			"must be >= 0",
		))
	}

	// NodePort range (also validated by CRD schema, but defense in depth)
	if cd.Spec.NodePort != 0 && (cd.Spec.NodePort < 30000 || cd.Spec.NodePort > 32767) {
		allErrs = append(allErrs, field.Invalid(
			specPath.Child("nodePort"),
			cd.Spec.NodePort,
			"must be between 30000 and 32767",
		))
	}

	if len(allErrs) > 0 {
		return nil, allErrs.ToAggregate()
	}
	return nil, nil
}

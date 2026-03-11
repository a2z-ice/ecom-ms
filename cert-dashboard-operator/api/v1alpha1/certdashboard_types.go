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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CertDashboardSpec defines the desired state of CertDashboard.
type CertDashboardSpec struct {
	// Namespaces to monitor for Certificate resources. Empty means all namespaces.
	// +optional
	Namespaces []string `json:"namespaces,omitempty"`

	// NodePort to expose the dashboard (default: 32600).
	// +kubebuilder:default=32600
	// +kubebuilder:validation:Minimum=30000
	// +kubebuilder:validation:Maximum=32767
	// +optional
	NodePort int32 `json:"nodePort,omitempty"`

	// YellowThresholdDays is the number of days before expiry when the progress bar turns yellow.
	// +kubebuilder:default=10
	// +optional
	YellowThresholdDays int `json:"yellowThresholdDays,omitempty"`

	// RedThresholdDays is the number of days before expiry when the progress bar turns red.
	// +kubebuilder:default=5
	// +optional
	RedThresholdDays int `json:"redThresholdDays,omitempty"`

	// Replicas for the dashboard deployment.
	// +kubebuilder:default=1
	// +optional
	Replicas int32 `json:"replicas,omitempty"`

	// Image is the container image for the dashboard.
	// +kubebuilder:default="bookstore/cert-dashboard:latest"
	// +optional
	Image string `json:"image,omitempty"`
}

// CertDashboardStatus defines the observed state of CertDashboard.
type CertDashboardStatus struct {
	// Ready indicates the dashboard deployment is available.
	Ready bool `json:"ready,omitempty"`

	// URL is the dashboard URL.
	URL string `json:"url,omitempty"`

	// Conditions represent the latest available observations.
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="URL",type="string",JSONPath=".status.url"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// CertDashboard is the Schema for the certdashboards API.
type CertDashboard struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   CertDashboardSpec   `json:"spec,omitempty"`
	Status CertDashboardStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// CertDashboardList contains a list of CertDashboard.
type CertDashboardList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []CertDashboard `json:"items"`
}

func init() {
	SchemeBuilder.Register(&CertDashboard{}, &CertDashboardList{})
}

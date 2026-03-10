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

package controller

import (
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	certsv1alpha1 "github.com/bookstore/cert-dashboard-operator/api/v1alpha1"
)

var _ = Describe("CertDashboard Controller", func() {
	const resourceName = "test-dashboard"
	const ns = "default"

	ctx := context.Background()
	namespacedName := types.NamespacedName{Name: resourceName, Namespace: ns}

	reconciler := func() *CertDashboardReconciler {
		return &CertDashboardReconciler{
			Client: k8sClient,
			Scheme: k8sClient.Scheme(),
		}
	}

	createDashboard := func(spec certsv1alpha1.CertDashboardSpec) {
		resource := &certsv1alpha1.CertDashboard{
			ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: ns},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, resource)).To(Succeed())
	}

	cleanupDashboard := func() {
		resource := &certsv1alpha1.CertDashboard{}
		err := k8sClient.Get(ctx, namespacedName, resource)
		if err == nil {
			// Remove finalizer to allow deletion in envtest
			resource.Finalizers = nil
			_ = k8sClient.Update(ctx, resource)
			_ = k8sClient.Delete(ctx, resource)
		}
		// Clean up cluster-scoped resources
		crName := "cert-dashboard-" + resourceName
		_ = k8sClient.Delete(ctx, &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: crName}})
		_ = k8sClient.Delete(ctx, &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: crName}})
	}

	Context("When reconciling a new CertDashboard", func() {
		BeforeEach(func() {
			cleanupDashboard()
		})
		AfterEach(func() {
			cleanupDashboard()
		})

		It("should successfully reconcile and create all child resources", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{
				NodePort:            32600,
				Replicas:            1,
				Image:               "bookstore/cert-dashboard:latest",
				YellowThresholdDays: 10,
				RedThresholdDays:    5,
			})

			r := reconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			By("creating a ServiceAccount")
			sa := &corev1.ServiceAccount{}
			Expect(k8sClient.Get(ctx, namespacedName, sa)).To(Succeed())
			Expect(sa.OwnerReferences).To(HaveLen(1))

			By("creating a ClusterRole with cert-manager permissions")
			cr := &rbacv1.ClusterRole{}
			crName := "cert-dashboard-" + resourceName
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: crName}, cr)).To(Succeed())
			Expect(cr.Rules).To(HaveLen(2))
			// First rule: cert-manager.io resources
			Expect(cr.Rules[0].APIGroups).To(ContainElement("cert-manager.io"))
			Expect(cr.Rules[0].Resources).To(ContainElements("certificates", "certificaterequests"))
			// Second rule: secrets
			Expect(cr.Rules[1].Resources).To(ContainElement("secrets"))
			Expect(cr.Rules[1].Verbs).To(ContainElement("delete"))

			By("creating a ClusterRoleBinding")
			crb := &rbacv1.ClusterRoleBinding{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: crName}, crb)).To(Succeed())
			Expect(crb.Subjects).To(HaveLen(1))
			Expect(crb.Subjects[0].Name).To(Equal(resourceName))
			Expect(crb.Subjects[0].Namespace).To(Equal(ns))

			By("creating a Deployment with correct spec")
			deploy := &appsv1.Deployment{}
			Expect(k8sClient.Get(ctx, namespacedName, deploy)).To(Succeed())
			Expect(deploy.OwnerReferences).To(HaveLen(1))
			Expect(*deploy.Spec.Replicas).To(Equal(int32(1)))
			Expect(deploy.Spec.Template.Spec.Containers).To(HaveLen(1))

			container := deploy.Spec.Template.Spec.Containers[0]
			Expect(container.Name).To(Equal("dashboard"))
			Expect(container.Image).To(Equal("bookstore/cert-dashboard:latest"))
			Expect(container.Command).To(Equal([]string{"/dashboard"}))

			By("setting pod-level security context with seccomp")
			podSec := deploy.Spec.Template.Spec.SecurityContext
			Expect(podSec).NotTo(BeNil())
			Expect(*podSec.RunAsNonRoot).To(BeTrue())
			Expect(podSec.SeccompProfile).NotTo(BeNil())
			Expect(podSec.SeccompProfile.Type).To(Equal(corev1.SeccompProfileTypeRuntimeDefault))

			By("setting container-level security context with capabilities drop")
			sec := container.SecurityContext
			Expect(sec).NotTo(BeNil())
			Expect(*sec.RunAsNonRoot).To(BeTrue())
			Expect(*sec.RunAsUser).To(Equal(int64(1000)))
			Expect(*sec.ReadOnlyRootFilesystem).To(BeTrue())
			Expect(*sec.AllowPrivilegeEscalation).To(BeFalse())
			Expect(sec.Capabilities).NotTo(BeNil())
			Expect(sec.Capabilities.Drop).To(ContainElement(corev1.Capability("ALL")))

			By("configuring liveness and readiness probes")
			Expect(container.LivenessProbe).NotTo(BeNil())
			Expect(container.LivenessProbe.HTTPGet.Path).To(Equal("/healthz"))
			Expect(container.ReadinessProbe).NotTo(BeNil())
			Expect(container.ReadinessProbe.HTTPGet.Path).To(Equal("/healthz"))

			By("setting resource requests and limits")
			Expect(container.Resources.Requests).NotTo(BeNil())
			Expect(container.Resources.Limits).NotTo(BeNil())

			By("passing config via environment variables")
			envNames := make([]string, 0, len(container.Env))
			for _, e := range container.Env {
				envNames = append(envNames, e.Name)
			}
			Expect(envNames).To(ContainElements("DASHBOARD_PORT", "NAMESPACES", "YELLOW_THRESHOLD_DAYS", "RED_THRESHOLD_DAYS"))

			By("creating a NodePort Service")
			svc := &corev1.Service{}
			Expect(k8sClient.Get(ctx, namespacedName, svc)).To(Succeed())
			Expect(svc.OwnerReferences).To(HaveLen(1))
			Expect(svc.Spec.Type).To(Equal(corev1.ServiceTypeNodePort))
			Expect(svc.Spec.Ports).To(HaveLen(1))
			Expect(svc.Spec.Ports[0].NodePort).To(Equal(int32(32600)))
		})

		It("should apply defaults when spec fields are zero/empty", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{})

			r := reconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			deploy := &appsv1.Deployment{}
			Expect(k8sClient.Get(ctx, namespacedName, deploy)).To(Succeed())
			Expect(*deploy.Spec.Replicas).To(Equal(int32(1)))
			Expect(deploy.Spec.Template.Spec.Containers[0].Image).To(Equal("bookstore/cert-dashboard:latest"))

			svc := &corev1.Service{}
			Expect(k8sClient.Get(ctx, namespacedName, svc)).To(Succeed())
			Expect(svc.Spec.Ports[0].NodePort).To(Equal(int32(32600)))
		})

		It("should add a finalizer on first reconcile", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{Image: "test:latest"})

			r := reconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			dashboard := &certsv1alpha1.CertDashboard{}
			Expect(k8sClient.Get(ctx, namespacedName, dashboard)).To(Succeed())
			Expect(dashboard.Finalizers).To(ContainElement("certs.bookstore.io/finalizer"))
		})

		It("should set status conditions with ObservedGeneration", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{Image: "test:latest"})

			r := reconciler()
			// Reconcile twice: first adds finalizer, second creates resources + status
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			dashboard := &certsv1alpha1.CertDashboard{}
			Expect(k8sClient.Get(ctx, namespacedName, dashboard)).To(Succeed())
			Expect(dashboard.Status.Conditions).NotTo(BeEmpty())

			avail := dashboard.Status.Conditions[0]
			Expect(avail.Type).To(Equal("Available"))
			Expect(avail.ObservedGeneration).To(Equal(dashboard.Generation))
		})

		It("should requeue when deployment is not ready", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{Image: "test:latest"})

			r := reconciler()
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			result, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())
			// In envtest, no kubelet runs, so deployment never becomes ready → requeue
			Expect(result.RequeueAfter).NotTo(BeZero())
		})

		It("should handle non-existent resource without error", func() {
			r := reconciler()
			_, err := r.Reconcile(ctx, reconcile.Request{
				NamespacedName: types.NamespacedName{Name: "does-not-exist", Namespace: ns},
			})
			Expect(err).NotTo(HaveOccurred())
		})

		It("should update existing resources on re-reconcile with changed spec", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{
				Image:    "bookstore/cert-dashboard:v1",
				Replicas: 1,
			})

			r := reconciler()
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})

			// Update the spec
			dashboard := &certsv1alpha1.CertDashboard{}
			Expect(k8sClient.Get(ctx, namespacedName, dashboard)).To(Succeed())
			dashboard.Spec.Image = "bookstore/cert-dashboard:v2"
			dashboard.Spec.Replicas = 2
			Expect(k8sClient.Update(ctx, dashboard)).To(Succeed())

			// Re-reconcile
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			deploy := &appsv1.Deployment{}
			Expect(k8sClient.Get(ctx, namespacedName, deploy)).To(Succeed())
			Expect(deploy.Spec.Template.Spec.Containers[0].Image).To(Equal("bookstore/cert-dashboard:v2"))
			Expect(*deploy.Spec.Replicas).To(Equal(int32(2)))
		})
	})

	Context("When deleting a CertDashboard", func() {
		It("should clean up cluster-scoped resources via finalizer", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{Image: "test:latest"})

			r := reconciler()
			// Reconcile to create resources + add finalizer
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})

			crName := "cert-dashboard-" + resourceName

			// Verify ClusterRole exists
			cr := &rbacv1.ClusterRole{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: crName}, cr)).To(Succeed())

			// Delete the dashboard
			dashboard := &certsv1alpha1.CertDashboard{}
			Expect(k8sClient.Get(ctx, namespacedName, dashboard)).To(Succeed())
			Expect(k8sClient.Delete(ctx, dashboard)).To(Succeed())

			// Reconcile the deletion
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			Expect(err).NotTo(HaveOccurred())

			// Verify cluster-scoped resources are cleaned up
			err = k8sClient.Get(ctx, types.NamespacedName{Name: crName}, &rbacv1.ClusterRole{})
			Expect(errors.IsNotFound(err)).To(BeTrue(), "ClusterRole should be deleted")

			err = k8sClient.Get(ctx, types.NamespacedName{Name: crName}, &rbacv1.ClusterRoleBinding{})
			Expect(errors.IsNotFound(err)).To(BeTrue(), "ClusterRoleBinding should be deleted")
		})
	})

	Context("Kubernetes standard labels", func() {
		It("should set standard app.kubernetes.io labels on deployment", func() {
			createDashboard(certsv1alpha1.CertDashboardSpec{Image: "test:latest"})

			r := reconciler()
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})
			_, _ = r.Reconcile(ctx, reconcile.Request{NamespacedName: namespacedName})

			deploy := &appsv1.Deployment{}
			Expect(k8sClient.Get(ctx, namespacedName, deploy)).To(Succeed())

			labels := deploy.Spec.Template.Labels
			Expect(labels).To(HaveKeyWithValue("app.kubernetes.io/name", "cert-dashboard"))
			Expect(labels).To(HaveKeyWithValue("app.kubernetes.io/instance", resourceName))
			Expect(labels).To(HaveKeyWithValue("app.kubernetes.io/managed-by", "cert-dashboard-operator"))
		})
	})
})

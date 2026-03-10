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
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	certsv1alpha1 "github.com/bookstore/cert-dashboard-operator/api/v1alpha1"
)

const dashboardFinalizer = "certs.bookstore.io/finalizer"

// CertDashboardReconciler reconciles a CertDashboard object
type CertDashboardReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=certs.bookstore.io,resources=certdashboards,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=certs.bookstore.io,resources=certdashboards/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=certs.bookstore.io,resources=certdashboards/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services;serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles;clusterrolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=cert-manager.io,resources=certificates;certificaterequests;clusterissuers;issuers,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;delete
// +kubebuilder:rbac:groups=authentication.k8s.io,resources=tokenreviews,verbs=create

func (r *CertDashboardReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	// Fetch the CertDashboard instance
	dashboard := &certsv1alpha1.CertDashboard{}
	if err := r.Get(ctx, req.NamespacedName, dashboard); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Handle deletion
	if !dashboard.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(dashboard, dashboardFinalizer) {
			// Clean up cluster-scoped resources
			r.cleanupClusterResources(ctx, dashboard)
			controllerutil.RemoveFinalizer(dashboard, dashboardFinalizer)
			if err := r.Update(ctx, dashboard); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	// Add finalizer
	if !controllerutil.ContainsFinalizer(dashboard, dashboardFinalizer) {
		controllerutil.AddFinalizer(dashboard, dashboardFinalizer)
		if err := r.Update(ctx, dashboard); err != nil {
			return ctrl.Result{}, err
		}
	}

	// Set defaults
	if dashboard.Spec.NodePort == 0 {
		dashboard.Spec.NodePort = 32600
	}
	if dashboard.Spec.Replicas == 0 {
		dashboard.Spec.Replicas = 1
	}
	if dashboard.Spec.YellowThresholdDays == 0 {
		dashboard.Spec.YellowThresholdDays = 10
	}
	if dashboard.Spec.RedThresholdDays == 0 {
		dashboard.Spec.RedThresholdDays = 5
	}
	if dashboard.Spec.Image == "" {
		dashboard.Spec.Image = "bookstore/cert-dashboard:latest"
	}

	ns := dashboard.Namespace
	name := dashboard.Name

	// 1. ServiceAccount
	if err := r.reconcileServiceAccount(ctx, dashboard, ns, name); err != nil {
		return ctrl.Result{}, err
	}

	// 2. ClusterRole + ClusterRoleBinding for cert-manager access
	if err := r.reconcileRBAC(ctx, dashboard, ns, name); err != nil {
		return ctrl.Result{}, err
	}

	// 3. Deployment
	if err := r.reconcileDeployment(ctx, dashboard, ns, name); err != nil {
		return ctrl.Result{}, err
	}

	// 4. Service
	if err := r.reconcileService(ctx, dashboard, ns, name); err != nil {
		return ctrl.Result{}, err
	}

	// Update status
	deploy := &appsv1.Deployment{}
	ready := false
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, deploy); err == nil {
		ready = deploy.Status.ReadyReplicas > 0
		dashboard.Status.Ready = ready
		dashboard.Status.URL = fmt.Sprintf("http://localhost:%d", dashboard.Spec.NodePort)

		condition := metav1.Condition{
			Type:               "Available",
			Status:             metav1.ConditionFalse,
			Reason:             "NotReady",
			Message:            "Dashboard deployment is not ready",
			ObservedGeneration: dashboard.Generation,
			LastTransitionTime: metav1.Now(),
		}
		if ready {
			condition.Status = metav1.ConditionTrue
			condition.Reason = "DeploymentReady"
			condition.Message = "Dashboard is available"
		}
		meta.SetStatusCondition(&dashboard.Status.Conditions, condition)
	}

	if err := r.Status().Update(ctx, dashboard); err != nil {
		log.Error(err, "Failed to update status")
		return ctrl.Result{}, err
	}

	// Requeue if deployment not ready yet to update status when it becomes ready
	if !ready {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	}

	return ctrl.Result{}, nil
}

func (r *CertDashboardReconciler) reconcileServiceAccount(ctx context.Context, owner *certsv1alpha1.CertDashboard, ns, name string) error {
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		return controllerutil.SetControllerReference(owner, sa, r.Scheme)
	})
	return err
}

func (r *CertDashboardReconciler) reconcileRBAC(ctx context.Context, owner *certsv1alpha1.CertDashboard, ns, name string) error {
	crName := fmt.Sprintf("cert-dashboard-%s", name)

	cr := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: crName},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, cr, func() error {
		cr.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{"cert-manager.io"},
				Resources: []string{"certificates", "certificaterequests", "clusterissuers", "issuers"},
				Verbs:     []string{"get", "list", "watch"},
			},
			{
				APIGroups: []string{""},
				Resources: []string{"secrets"},
				Verbs:     []string{"get", "list", "watch", "delete"},
			},
			{
				APIGroups: []string{"authentication.k8s.io"},
				Resources: []string{"tokenreviews"},
				Verbs:     []string{"create"},
			},
		}
		return nil
	})
	if err != nil {
		return err
	}

	crb := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: crName},
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, crb, func() error {
		crb.RoleRef = rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     crName,
		}
		crb.Subjects = []rbacv1.Subject{
			{
				Kind:      "ServiceAccount",
				Name:      name,
				Namespace: ns,
			},
		}
		return nil
	})
	return err
}

func (r *CertDashboardReconciler) reconcileDeployment(ctx context.Context, owner *certsv1alpha1.CertDashboard, ns, name string) error {
	labels := map[string]string{
		"app":                          "cert-dashboard",
		"app.kubernetes.io/name":       "cert-dashboard",
		"app.kubernetes.io/instance":   name,
		"app.kubernetes.io/managed-by": "cert-dashboard-operator",
	}

	namespaces := ""
	if len(owner.Spec.Namespaces) > 0 {
		namespaces = strings.Join(owner.Spec.Namespaces, ",")
	}

	deploy := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
		replicas := owner.Spec.Replicas
		deploy.Spec = appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					ServiceAccountName: name,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: boolPtr(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{
						{
							Name:            "dashboard",
							Image:           owner.Spec.Image,
							ImagePullPolicy: corev1.PullIfNotPresent,
							Command:         []string{"/dashboard"},
							Ports: []corev1.ContainerPort{
								{Name: "http", ContainerPort: 8080, Protocol: corev1.ProtocolTCP},
							},
							Env: []corev1.EnvVar{
								{Name: "DASHBOARD_PORT", Value: "8080"},
								{Name: "NAMESPACES", Value: namespaces},
								{Name: "YELLOW_THRESHOLD_DAYS", Value: fmt.Sprintf("%d", owner.Spec.YellowThresholdDays)},
								{Name: "RED_THRESHOLD_DAYS", Value: fmt.Sprintf("%d", owner.Spec.RedThresholdDays)},
							},
							Resources: corev1.ResourceRequirements{
								Requests: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("50m"),
									corev1.ResourceMemory: resource.MustParse("64Mi"),
								},
								Limits: corev1.ResourceList{
									corev1.ResourceCPU:    resource.MustParse("200m"),
									corev1.ResourceMemory: resource.MustParse("128Mi"),
								},
							},
							LivenessProbe: &corev1.Probe{
								ProbeHandler: corev1.ProbeHandler{
									HTTPGet: &corev1.HTTPGetAction{
										Path: "/healthz",
										Port: intstr.FromInt(8080),
									},
								},
								InitialDelaySeconds: 5,
								PeriodSeconds:       10,
							},
							ReadinessProbe: &corev1.Probe{
								ProbeHandler: corev1.ProbeHandler{
									HTTPGet: &corev1.HTTPGetAction{
										Path: "/healthz",
										Port: intstr.FromInt(8080),
									},
								},
								InitialDelaySeconds: 3,
								PeriodSeconds:       5,
							},
							SecurityContext: &corev1.SecurityContext{
								RunAsNonRoot:             boolPtr(true),
								RunAsUser:                int64Ptr(1000),
								ReadOnlyRootFilesystem:   boolPtr(true),
								AllowPrivilegeEscalation: boolPtr(false),
								Capabilities: &corev1.Capabilities{
									Drop: []corev1.Capability{"ALL"},
								},
							},
						},
					},
				},
			},
		}
		return controllerutil.SetControllerReference(owner, deploy, r.Scheme)
	})
	return err
}

func (r *CertDashboardReconciler) reconcileService(ctx context.Context, owner *certsv1alpha1.CertDashboard, ns, name string) error {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Spec = corev1.ServiceSpec{
			Type: corev1.ServiceTypeNodePort,
			Selector: map[string]string{
				"app":                    "cert-dashboard",
				"app.kubernetes.io/name": "cert-dashboard",
			},
			Ports: []corev1.ServicePort{
				{
					Name:       "http",
					Port:       8080,
					TargetPort: intstr.FromInt(8080),
					Protocol:   corev1.ProtocolTCP,
					NodePort:   owner.Spec.NodePort,
				},
			},
		}
		return controllerutil.SetControllerReference(owner, svc, r.Scheme)
	})
	return err
}

func (r *CertDashboardReconciler) cleanupClusterResources(ctx context.Context, dashboard *certsv1alpha1.CertDashboard) {
	crName := fmt.Sprintf("cert-dashboard-%s", dashboard.Name)
	r.Client.Delete(ctx, &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: crName}})
	r.Client.Delete(ctx, &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: crName}})
}

// SetupWithManager sets up the controller with the Manager.
func (r *CertDashboardReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&certsv1alpha1.CertDashboard{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ServiceAccount{}).
		Named("certdashboard").
		Complete(r)
}

func boolPtr(b bool) *bool    { return &b }
func int64Ptr(i int64) *int64 { return &i }
